import { SignatureHelp, SignatureInformation, ParameterInformation } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from 'tree-sitter';
import { SymbolDef } from './types';
import { getNodeAtPosition } from './utils';

export function getSignatureHelp(
    doc: TextDocument,
    position: { line: number; character: number },
    definitions: Map<string, SymbolDef>,
    getTree: (uri: string) => Parser.Tree | undefined,
): SignatureHelp | null {
    const tree = getTree(doc.uri);
    if (!tree) return null;

    // Get the line text up to cursor
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const lineText = lines[position.line] || '';
    const textBeforeCursor = lineText.substring(0, position.character);

    // Try to find a macro invocation on this line
    // RGBDS macro invocation syntax: MacroName arg1, arg2, arg3
    // The macro name is at the start of the line (after optional whitespace)

    // Get the AST node at cursor
    const node = getNodeAtPosition(tree, position.line, position.character);
    if (!node) return null;

    // Walk up to find a macro_invocation or line node
    let current: Parser.SyntaxNode | null = node;
    let macroNode: Parser.SyntaxNode | null = null;
    while (current) {
        if (current.type === 'macro_invocation') {
            macroNode = current;
            break;
        }
        if (current.type === 'source_file') break;
        current = current.parent;
    }

    // If not in a macro_invocation AST node, try regex-based detection
    // (user might be typing a new invocation that tree-sitter hasn't parsed yet)
    let macroName: string | null = null;

    if (macroNode) {
        // Extract macro name from AST node
        const nameChild = macroNode.namedChildren.find(c => c.type === 'identifier');
        if (nameChild) macroName = nameChild.text;
    } else {
        // Fallback: check if line starts with a known macro name
        const match = textBeforeCursor.match(/^\s*([a-zA-Z_][a-zA-Z0-9_@#]*)\s/);
        if (match) {
            const candidate = match[1];
            const def = definitions.get(candidate);
            if (def?.type === 'macro') {
                macroName = candidate;
            }
        }
    }

    if (!macroName) return null;

    const macroDef = definitions.get(macroName);
    if (!macroDef || macroDef.type !== 'macro') return null;

    // Determine parameter count by scanning the macro body for \1, \2, etc.
    const macroTree = getTree(macroDef.file);
    let maxParam = 0;
    if (macroTree) {
        const macroSource = macroTree.rootNode.text;
        const macroLines = macroSource.split(/\r?\n/);
        // Scan from the line after the macro definition until ENDM
        for (let i = macroDef.line + 1; i < macroLines.length; i++) {
            const line = macroLines[i];
            if (/^\s*ENDM\b/i.test(line)) break;
            // Find \1 through \9 references
            const paramRefs = line.match(/\\([1-9])/g);
            if (paramRefs) {
                for (const ref of paramRefs) {
                    const num = parseInt(ref[1]);
                    if (num > maxParam) maxParam = num;
                }
            }
        }
    }

    if (maxParam === 0) maxParam = 1; // assume at least 1 param if it's a macro

    // Count commas before cursor to determine active parameter
    // Only count commas AFTER the macro name
    const afterName = textBeforeCursor.replace(/^\s*[a-zA-Z_][a-zA-Z0-9_@#]*\s*/, '');
    let activeParam = 0;
    let inString = false;
    for (const ch of afterName) {
        if (ch === '"') inString = !inString;
        if (ch === ',' && !inString) activeParam++;
    }

    // Build parameter labels
    const params: ParameterInformation[] = [];
    for (let i = 1; i <= maxParam; i++) {
        params.push({ label: `\\${i}` });
    }

    const signature: SignatureInformation = {
        label: `${macroName} ${params.map(p => p.label).join(', ')}`,
        documentation: macroDef.docComment || undefined,
        parameters: params,
    };

    return {
        signatures: [signature],
        activeSignature: 0,
        activeParameter: Math.min(activeParam, maxParam - 1),
    };
}
