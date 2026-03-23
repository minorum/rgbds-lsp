import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    TextDocumentSyncKind,
    InitializeResult,
    Location,
    Range,
    DocumentSymbol,
    SymbolKind,
    SymbolInformation,
    DocumentSymbolParams,
    Hover,
    HoverParams,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    RenameParams,
    WorkspaceEdit,
    TextEdit,
    Diagnostic,
    DiagnosticSeverity,
    DocumentLink,
    DocumentLinkParams,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from 'tree-sitter';
import { rgbdsIndexer } from './indexer';
import { uriToPath, pathToUri, getNodeAtPosition, parseNumberLiteral } from './utils';
import { getCompletions } from './completions';
import { SM83_INSTRUCTIONS, InstructionForm } from './instructions';
import { DIRECTIVE_DOCS } from './directives';
import * as fs from 'fs';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let pendingWorkspaceFolders: string[] = [];

connection.onInitialize((params: InitializeParams) => {
    // Collect workspace folders for background indexing after handshake
    if (params.workspaceFolders) {
        for (const folder of params.workspaceFolders) {
            pendingWorkspaceFolders.push(uriToPath(folder.uri));
        }
    }

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Full,
            definitionProvider: true,
            referencesProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            completionProvider: { resolveProvider: false, triggerCharacters: ['"', '/'] },
            renameProvider: { prepareProvider: true },
            workspaceSymbolProvider: true,
            documentLinkProvider: {},
        },
    };

    if (params.capabilities.workspace?.workspaceFolders) {
        result.capabilities.workspace = {
            workspaceFolders: { supported: true },
        };
    }

    return result;
});

connection.onInitialized(() => {
    connection.console.log('RGBDS Language Server initialized');

    rgbdsIndexer.onLog = (msg) => connection.console.log(msg);

    // Index workspace folders in the background after the handshake completes
    const folders = [...pendingWorkspaceFolders];
    pendingWorkspaceFolders = [];
    (async () => {
        for (const folderPath of folders) {
            const result = await rgbdsIndexer.indexProjectAsync(folderPath);
            connection.console.log(`Indexed workspace: ${folderPath} (${rgbdsIndexer.definitions.size} definitions, ${result.indexed} files)`);
        }
        // Refresh diagnostics for all open documents now that indexing is complete
        for (const doc of documents.all()) {
            connection.sendDiagnostics({
                uri: doc.uri,
                diagnostics: computeDiagnostics(doc),
            });
        }
    })();
});

// Reindex on file change
documents.onDidChangeContent(change => {
    rgbdsIndexer.indexFile(change.document.uri, change.document.getText());

    // Send diagnostics
    const diagnostics = computeDiagnostics(change.document);
    connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

// ─── Go to Definition ─────────────────────────────────────────

connection.onDefinition((params: TextDocumentPositionParams): Location | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const symbol = getSymbolAtPosition(doc, params.position);
    if (!symbol) return null;

    const def = rgbdsIndexer.definitions.get(symbol);
    if (!def) return null;

    return {
        uri: def.file,
        range: Range.create(def.line, def.col, def.line, def.endCol),
    };
});

// ─── Find References ──────────────────────────────────────────

connection.onReferences((params): Location[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const symbol = getSymbolAtPosition(doc, params.position);
    if (!symbol) return [];

    const locations: Location[] = [];

    const refs = rgbdsIndexer.references.get(symbol) || [];
    for (const ref of refs) {
        locations.push({
            uri: ref.file,
            range: Range.create(ref.line, ref.col, ref.line, ref.endCol),
        });
    }

    // Include the definition itself
    const def = rgbdsIndexer.definitions.get(symbol);
    if (def) {
        locations.push({
            uri: def.file,
            range: Range.create(def.line, def.col, def.line, def.endCol),
        });
    }

    return locations;
});

// ─── Hover ────────────────────────────────────────────────────

connection.onHover((params: HoverParams): Hover | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    // Skip hover inside strings
    const hoverTree = rgbdsIndexer.getTree(doc.uri);
    if (hoverTree) {
        const hoverNode = getNodeAtPosition(hoverTree, params.position.line, params.position.character);
        let walk: Parser.SyntaxNode | null = hoverNode;
        while (walk) {
            if (walk.type === 'string') return null;
            walk = walk.parent;
        }
    }

    // Try symbol hover first
    const symbol = getSymbolAtPosition(doc, params.position);
    if (symbol) {
        const def = rgbdsIndexer.definitions.get(symbol);
        if (def) {
            const refs = rgbdsIndexer.references.get(symbol) || [];

            // Build signature line
            let signature = def.name;
            if (def.type === 'constant' && def.value) {
                signature += ` EQU ${def.value}`;
            }

            let md = `\`\`\`rgbds\n${signature}\n\`\`\`\n`;
            // Info line
            const info: string[] = [`*${def.type}*`];
            if (def.isExported) info.push('exported');
            info.push(`\`${path.basename(uriToPath(def.file))}:${def.line + 1}\``);
            if (refs.length > 0) info.push(`${refs.length} ref${refs.length === 1 ? '' : 's'}`);
            md += info.join(' · ');

            // For numeric constants, show value in other bases
            if (def.type === 'constant' && def.value) {
                const parsed = parseNumberLiteral(def.value);
                if (parsed && !parsed.isFixedPoint) {
                    md += `\n\n\`${parsed.decimal}\` · \`${parsed.hex}\` · \`${parsed.binary}\``;
                }
            }

            if (def.docComment) md += `\n\n---\n\n${def.docComment}`;

            return { contents: { kind: 'markdown', value: md } };
        }
    }

    // Try AST-based hover (numbers, mnemonics, directives)
    const tree = rgbdsIndexer.getTree(doc.uri);
    if (tree) {
        const node = getNodeAtPosition(tree, params.position.line, params.position.character);

        // Number literal hover
        if (node.type === 'number') {
            const parsed = parseNumberLiteral(node.text);
            if (parsed) {
                let md: string;
                if (parsed.isFixedPoint) {
                    md = `\`${node.text}\` = **${parsed.decimal}** *(fixed-point)*`;
                } else {
                    md = `\`\`\`\n`;
                    md += `Dec  ${parsed.decimal}\n`;
                    md += `Hex  ${parsed.hex}\n`;
                    md += `Bin  ${parsed.binary}\n`;
                    md += `Oct  ${parsed.octal}\n`;
                    md += `\`\`\``;
                }
                return { contents: { kind: 'markdown', value: md } };
            }
        }

        // Instruction mnemonic hover
        if (node.type === 'mnemonic') {
            const mnemonic = node.text.toLowerCase();
            const forms = SM83_INSTRUCTIONS.filter(i => i.mnemonic === mnemonic);
            if (forms.length > 0) {
                // Try to match the specific form from the AST
                const instrNode = node.parent;
                const matched = instrNode ? matchInstructionForm(instrNode, forms) : null;
                const primary = matched || forms[0];

                let md = `\`\`\`rgbds\n${primary.label}\n\`\`\`\n`;
                md += `${primary.description}\n\n`;
                md += `${primary.bytes} byte${primary.bytes > 1 ? 's' : ''} · ${primary.cycles} cycles`;
                if (primary.flags !== '-') md += ` · \`${primary.flags}\``;

                return { contents: { kind: 'markdown', value: md } };
            }
        }

        // Directive keyword hover
        const directiveKey = getDirectiveKeyword(node);
        if (directiveKey) {
            const dirDoc = DIRECTIVE_DOCS.get(directiveKey);
            if (dirDoc) {
                let md = `\`\`\`rgbds\n${dirDoc.syntax}\n\`\`\`\n\n`;
                md += dirDoc.description;
                return { contents: { kind: 'markdown', value: md } };
            }
        }
    }

    return null;
});

// ─── Document Symbols ─────────────────────────────────────────

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
    const symbols: DocumentSymbol[] = [];
    let currentGlobal: DocumentSymbol | null = null;

    const defs = Array.from(rgbdsIndexer.definitions.values())
        .filter(d => d.file === params.textDocument.uri)
        .sort((a, b) => a.line - b.line);

    for (const def of defs) {
        let kind: SymbolKind = SymbolKind.Variable;
        if (def.type === 'label') kind = SymbolKind.Function;
        else if (def.type === 'constant') kind = SymbolKind.Constant;
        else if (def.type === 'macro') kind = SymbolKind.Method;
        else if (def.type === 'section') kind = SymbolKind.Namespace;

        const range = Range.create(def.line, def.col, def.line, def.endCol);
        const docSymbol: DocumentSymbol = {
            name: def.name,
            kind,
            range,
            selectionRange: range,
            children: [],
        };

        if (def.isLocal && currentGlobal?.children) {
            currentGlobal.children.push(docSymbol);
        } else {
            if (def.type === 'label' || def.type === 'section') {
                currentGlobal = docSymbol;
            }
            symbols.push(docSymbol);
        }
    }

    return symbols;
});

// ─── Workspace Symbols ───────────────────────────────────────

connection.onWorkspaceSymbol((params): SymbolInformation[] => {
    const query = params.query.toLowerCase();
    const results: SymbolInformation[] = [];

    for (const [name, def] of rgbdsIndexer.definitions) {
        if (query && !name.toLowerCase().includes(query)) continue;

        let kind: SymbolKind = SymbolKind.Variable;
        if (def.type === 'label') kind = SymbolKind.Function;
        else if (def.type === 'constant') kind = SymbolKind.Constant;
        else if (def.type === 'macro') kind = SymbolKind.Method;
        else if (def.type === 'section') kind = SymbolKind.Namespace;

        results.push({
            name,
            kind,
            location: {
                uri: def.file,
                range: Range.create(def.line, def.col, def.line, def.endCol),
            },
        });

        if (results.length >= 500) break;
    }

    return results;
});

// ─── Document Links ──────────────────────────────────────────

connection.onDocumentLinks((params: DocumentLinkParams): DocumentLink[] => {
    const tree = rgbdsIndexer.getTree(params.textDocument.uri);
    if (!tree) return [];

    const links: DocumentLink[] = [];
    const docPath = uriToPath(params.textDocument.uri);
    const docDir = path.dirname(docPath);

    for (const lineNode of tree.rootNode.children) {
        if (lineNode.type !== 'line' && lineNode.type !== 'final_line') continue;

        for (const child of lineNode.children) {
            if (child.type !== 'statement') continue;
            for (const stmt of child.children) {
                if (stmt.type !== 'directive') continue;
                const directive = stmt.firstChild;
                if (!directive) continue;
                if (directive.type !== 'include_directive' && directive.type !== 'incbin_directive') continue;

                const stringNode = directive.children.find(c => c.type === 'string');
                if (!stringNode) continue;

                // Strip quotes (handle "", """""", #"")
                let raw = stringNode.text;
                if (raw.startsWith('#')) raw = raw.substring(1);
                if (raw.startsWith('"""')) raw = raw.slice(3, -3);
                else raw = raw.slice(1, -1);

                const resolved = path.resolve(docDir, raw);
                if (fs.existsSync(resolved)) {
                    links.push({
                        range: Range.create(
                            stringNode.startPosition.row,
                            stringNode.startPosition.column,
                            stringNode.endPosition.row,
                            stringNode.endPosition.column,
                        ),
                        target: pathToUri(resolved),
                    });
                }
            }
        }
    }

    return links;
});

// ─── Completion ───────────────────────────────────────────────

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
    const doc = documents.get(params.textDocument.uri);
    const lineText = doc
        ? (doc.getText().split(/\r?\n/)[params.position.line] || '')
        : '';

    return getCompletions(params, rgbdsIndexer, lineText);
});

// ─── Rename ───────────────────────────────────────────────────

connection.onPrepareRename((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const symbol = getSymbolAtPosition(doc, params.position);
    if (!symbol) return null;

    const def = rgbdsIndexer.definitions.get(symbol);
    if (!def) return null;

    // Return the range of the word under cursor
    const word = getWordRangeAtPosition(doc, params.position);
    return word;
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const symbol = getSymbolAtPosition(doc, params.position);
    if (!symbol) return null;

    // Validate new name
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(params.newName) && !/^\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(params.newName)) {
        return null;
    }

    const def = rgbdsIndexer.definitions.get(symbol);
    const refs = rgbdsIndexer.references.get(symbol) || [];
    if (!def && refs.length === 0) return null;

    const changes: { [uri: string]: TextEdit[] } = {};

    const addEdit = (fileUri: string, line: number, col: number, endCol: number) => {
        if (!changes[fileUri]) changes[fileUri] = [];
        changes[fileUri].push(TextEdit.replace(
            Range.create(line, col, line, endCol),
            params.newName,
        ));
    };

    if (def) {
        addEdit(def.file, def.line, def.col, def.endCol);
    }
    for (const ref of refs) {
        addEdit(ref.file, ref.line, ref.col, ref.endCol);
    }

    return { changes };
});

// ─── Diagnostics ──────────────────────────────────────────────

function computeDiagnostics(doc: TextDocument): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const uri = doc.uri;

    // Find references to undefined symbols in this file
    for (const [name, refs] of rgbdsIndexer.references) {
        if (rgbdsIndexer.definitions.has(name)) continue;

        for (const ref of refs) {
            if (ref.file !== uri) continue;
            diagnostics.push({
                range: Range.create(ref.line, ref.col, ref.line, ref.endCol),
                severity: DiagnosticSeverity.Warning,
                message: `Undefined symbol: ${name}`,
                source: 'rgbds',
            });
        }
    }

    // Find duplicate definitions in this file
    const seenInFile = new Map<string, number>();
    for (const [name, def] of rgbdsIndexer.definitions) {
        if (def.file !== uri) continue;
        if (def.type === 'section') continue; // sections can be duplicated
        // Check if another def with same name exists in a different file
        // (We only report if we find multiple defs with same name)
    }

    return diagnostics;
}

// ─── Utilities ────────────────────────────────────────────────

function getSymbolAtPosition(doc: TextDocument, position: { line: number; character: number }): string | null {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const lineText = lines[position.line];
    if (!lineText) return null;

    const wordRegex = /[a-zA-Z0-9_.]/;
    let start = position.character;
    let end = position.character;

    while (start > 0 && wordRegex.test(lineText[start - 1])) start--;
    while (end < lineText.length && wordRegex.test(lineText[end])) end++;

    if (start === end) return null;
    let word = lineText.substring(start, end);

    // If it's a local label reference (.something), scope it
    if (word.startsWith('.')) {
        let currentGlobal = '';
        for (let i = 0; i <= position.line; i++) {
            const m = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*::?/);
            if (m) currentGlobal = m[1];
        }
        if (currentGlobal) word = currentGlobal + word;
    }

    return word;
}

function getWordRangeAtPosition(doc: TextDocument, position: { line: number; character: number }): Range | null {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const lineText = lines[position.line];
    if (!lineText) return null;

    const wordRegex = /[a-zA-Z0-9_.]/;
    let start = position.character;
    let end = position.character;

    while (start > 0 && wordRegex.test(lineText[start - 1])) start--;
    while (end < lineText.length && wordRegex.test(lineText[end])) end++;

    if (start === end) return null;
    return Range.create(position.line, start, position.line, end);
}

// ─── Instruction form matching ────────────────────────────────

const REGISTERS_8 = new Set(['a', 'b', 'c', 'd', 'e', 'h', 'l']);
const REGISTERS_16 = new Set(['bc', 'de', 'hl']);

function matchInstructionForm(instrNode: Parser.SyntaxNode, forms: InstructionForm[]): InstructionForm | null {
    // Build a pattern string from the AST operands like "r8, [hl]" or "a, n8"
    const operandList = instrNode.children.find(c => c.type === 'operand_list');
    if (!operandList) {
        // No operands — match the bare mnemonic form
        return forms.find(f => !f.label.includes(' ') || f.label.split(' ').length === 1) || null;
    }

    const operands = operandList.children.filter(c => c.type === 'operand');
    const patterns: string[] = [];

    for (const op of operands) {
        patterns.push(classifyOperand(op));
    }

    const mnemonic = instrNode.children.find(c => c.type === 'mnemonic')?.text.toLowerCase() || '';
    const pattern = `${mnemonic} ${patterns.join(', ')}`;

    // Try exact match first, then fuzzy
    return forms.find(f => f.label === pattern)
        || forms.find(f => fuzzyFormMatch(f.label, mnemonic, patterns))
        || null;
}

function classifyOperand(op: Parser.SyntaxNode): string {
    const child = op.children[0] || op;

    if (child.type === 'register') {
        const reg = child.text.toLowerCase();
        if (REGISTERS_8.has(reg)) return reg === 'a' ? 'a' : 'r8';
        if (REGISTERS_16.has(reg)) return reg === 'hl' ? 'hl' : 'r16';
        return reg;
    }
    if (child.type === 'sp_register') return 'sp';
    if (child.type === 'sp_offset') return 'sp+e8';
    if (child.type === 'condition') return 'cc';
    if (child.type === 'memory_operand') {
        // [hl], [hl+], [hl-], [bc], [de], [c], [n16]
        const inner = child.children.find(c => c.type !== '[' && c.type !== ']' && c.text !== '[' && c.text !== ']');
        if (!inner) return '[n16]';
        const txt = child.text.toLowerCase();
        if (txt === '[hl]') return '[hl]';
        if (txt === '[hl+]' || txt === '[hli]') return '[hl+]';
        if (txt === '[hl-]' || txt === '[hld]') return '[hl-]';
        if (txt === '[c]') return '[c]';
        if (inner.type === 'register') {
            const reg = inner.text.toLowerCase();
            if (REGISTERS_16.has(reg)) return `[${reg === 'hl' ? 'hl' : 'r16'}]`;
            return `[${reg}]`;
        }
        return '[n16]';
    }
    // Expression — could be n8, n16, e8, u3
    return 'n8';
}

function fuzzyFormMatch(label: string, mnemonic: string, patterns: string[]): boolean {
    if (!label.startsWith(mnemonic + ' ')) return false;
    const formOperands = label.substring(mnemonic.length + 1).split(', ');
    if (formOperands.length !== patterns.length) return false;

    for (let i = 0; i < patterns.length; i++) {
        const p = patterns[i];
        const f = formOperands[i];
        // Direct match
        if (p === f) continue;
        // 'a' matches 'r8', specific register matches generic
        if (f === 'r8' && REGISTERS_8.has(p)) continue;
        if (f === 'r16' && REGISTERS_16.has(p)) continue;
        if (f === 'cc' && ['z', 'nz', 'c', 'nc'].includes(p)) continue;
        if (f === '[r16]' && ['[bc]', '[de]', '[hl]'].includes(p)) continue;
        // n8/n16/e8/u3 all come from expressions
        if (['n8', 'n16', 'e8', 'u3'].includes(f) && p === 'n8') continue;
        if (f === 'sp+e8' && p === 'sp+e8') continue;
        return false;
    }
    return true;
}

// Map directive node types (from grammar) to our doc keys
const DIRECTIVE_NODE_MAP: { [nodeType: string]: string } = {
    section_directive: 'section',
    load_directive: 'load',
    endsection_directive: 'endsection',
    data_directive: 'db', // resolved further by keyword text
    constant_directive: 'equ', // resolved further by keyword text
    include_directive: 'include',
    incbin_directive: 'incbin',
    export_directive: 'export',
    purge_directive: 'purge',
    macro_start: 'macro',
    endm_directive: 'endm',
    shift_directive: 'shift',
    if_directive: 'if',
    elif_directive: 'elif',
    else_directive: 'else',
    endc_directive: 'endc',
    rept_directive: 'rept',
    for_directive: 'for',
    endr_directive: 'endr',
    break_directive: 'break',
    endl_directive: 'endl',
    union_directive: 'union',
    nextu_directive: 'nextu',
    endu_directive: 'endu',
    charmap_directive: 'charmap',
    newcharmap_directive: 'newcharmap',
    setcharmap_directive: 'setcharmap',
    pushc_directive: 'pushc',
    popc_directive: 'popc',
    pushs_directive: 'pushs',
    pops_directive: 'pops',
    pusho_directive: 'pusho',
    popo_directive: 'popo',
    opt_directive: 'opt',
    assert_directive: 'assert',
    print_directive: 'print',
    warn_directive: 'warn',
    fail_directive: 'fail',
    rsreset_directive: 'rsreset',
    rsset_directive: 'rsset',
    rb_directive: 'rb',
    rw_directive: 'rw',
};

function getDirectiveKeyword(node: Parser.SyntaxNode): string | null {
    // Walk up to find a directive node
    let walk: Parser.SyntaxNode | null = node;
    while (walk) {
        const key = DIRECTIVE_NODE_MAP[walk.type];
        if (key !== undefined) {
            // For directives with anonymous keywords, extract from source text
            if (walk.type === 'data_directive' || walk.type === 'constant_directive') {
                const txt = walk.text.trimStart().toLowerCase();
                const kwMatch = txt.match(/^(db|dw|dl|ds|equ|equs|set|def|redef)\b/i);
                if (kwMatch) return kwMatch[1].toLowerCase();
            }
            return key;
        }
        if (walk.type === 'line' || walk.type === 'final_line') break;
        walk = walk.parent;
    }
    return null;
}

documents.listen(connection);
connection.listen();
