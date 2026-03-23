import Parser from 'tree-sitter';
import { SymbolDef, SymbolRef } from './types';
import { pathToUri, collectRgbdsFiles } from './utils';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Load tree-sitter-rgbds grammar
const rgbdsLanguage = require('@minorum/tree-sitter-rgbds');

const CACHE_VERSION = 1;
const CACHE_DIR = path.join(require('os').homedir(), '.rgbds-lsp', 'cache');

interface CacheEntry {
    hash: string;
    definitions: [string, SymbolDef][];
    references: [string, SymbolRef[]][];
}

interface CacheFile {
    version: number;
    files: { [filePath: string]: CacheEntry };
}

function contentHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

function cachePath(rootDir: string): string {
    const key = crypto.createHash('md5').update(rootDir).digest('hex');
    return path.join(CACHE_DIR, `${key}.json`);
}

export class Indexer {
    public definitions: Map<string, SymbolDef> = new Map();
    public references: Map<string, SymbolRef[]> = new Map();
    public onLog: ((message: string) => void) | null = null;

    private parser: Parser;
    private trees: Map<string, Parser.Tree> = new Map();
    private fileContents: Map<string, string> = new Map();
    private indexedFileUris: Set<string> = new Set();

    constructor() {
        this.parser = new Parser();
        this.parser.setLanguage(rgbdsLanguage);
    }

    private log(message: string): void {
        if (this.onLog) this.onLog(message);
    }

    public getIndexedFileUris(): string[] {
        return Array.from(this.indexedFileUris);
    }

    public getTree(uri: string): Parser.Tree | undefined {
        return this.trees.get(uri);
    }

    public clearAll(): void {
        this.definitions.clear();
        this.references.clear();
        this.trees.clear();
        this.fileContents.clear();
        this.indexedFileUris.clear();
    }

    public indexFile(uri: string, content: string): void {
        const oldTree = this.trees.get(uri);
        const tree = this.parser.parse(content, oldTree);
        this.trees.set(uri, tree);
        this.fileContents.set(uri, content);
        this.indexedFileUris.add(uri);
        this.reindexFile(uri, tree);
    }

    /** Remove symbols for a single file and re-extract them. */
    private reindexFile(uri: string, tree: Parser.Tree): void {
        // Remove old definitions from this file
        for (const [name, def] of this.definitions) {
            if (def.file === uri) this.definitions.delete(name);
        }
        // Remove old references from this file
        for (const [name, refs] of this.references) {
            const filtered = refs.filter(r => r.file !== uri);
            if (filtered.length === 0) {
                this.references.delete(name);
            } else {
                this.references.set(name, filtered);
            }
        }
        // Re-extract symbols for this file only
        this.extractSymbols(uri, tree);
    }

    public indexProject(rootDir: string): { indexed: number; failed: number } {
        const files = collectRgbdsFiles(rootDir);
        let indexed = 0;
        let failed = 0;

        for (const filePath of files) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const uri = pathToUri(filePath);
                const tree = this.parser.parse(content);
                this.trees.set(uri, tree);
                this.fileContents.set(uri, content);
                this.indexedFileUris.add(uri);
                indexed++;
            } catch {
                failed++;
            }
        }

        this.rebuildIndex();
        return { indexed, failed };
    }

    public async indexProjectAsync(rootDir: string): Promise<{ indexed: number; failed: number }> {
        const files = collectRgbdsFiles(rootDir);
        this.log(`Found ${files.length} .asm/.inc files in ${rootDir}`);

        // Load cache
        const cacheFile = cachePath(rootDir);
        const cache = this.loadCache(cacheFile);
        let indexed = 0;
        let cached = 0;
        let failed = 0;

        for (let i = 0; i < files.length; i++) {
            try {
                const content = fs.readFileSync(files[i], 'utf-8');
                const uri = pathToUri(files[i]);
                const hash = contentHash(content);
                this.fileContents.set(uri, content);
                this.indexedFileUris.add(uri);

                // Check cache
                const entry = cache?.files[files[i]];
                if (entry && entry.hash === hash) {
                    // Restore from cache — skip parsing
                    for (const [name, def] of entry.definitions) {
                        this.definitions.set(name, def);
                    }
                    for (const [name, refs] of entry.references) {
                        const existing = this.references.get(name);
                        if (existing) {
                            existing.push(...refs);
                        } else {
                            this.references.set(name, [...refs]);
                        }
                    }
                    cached++;
                } else {
                    // Parse and extract
                    const tree = this.parser.parse(content);
                    this.trees.set(uri, tree);
                    this.extractSymbols(uri, tree);
                    indexed++;
                }
            } catch (e) {
                this.log(`Failed to index: ${files[i]} (${e})`);
                failed++;
            }

            // Log progress every 50 files
            const total = indexed + cached;
            if (total % 50 === 0 && total > 0) {
                this.log(`Indexing progress: ${total}/${files.length} files (${cached} cached, ${this.definitions.size} definitions so far)`);
            }

            // Yield to the event loop every 10 files so LSP requests can be served
            if (i % 10 === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }

        // Save cache for next startup
        this.saveCache(cacheFile, files);
        this.log(`Cache: ${cached} files from cache, ${indexed} parsed fresh`);

        return { indexed: indexed + cached, failed };
    }

    private loadCache(cachePath: string): CacheFile | null {
        try {
            const raw = fs.readFileSync(cachePath, 'utf-8');
            const data = JSON.parse(raw) as CacheFile;
            if (data.version !== CACHE_VERSION) return null;
            return data;
        } catch {
            return null;
        }
    }

    private saveCache(cachePath: string, files: string[]): void {
        const cache: CacheFile = { version: CACHE_VERSION, files: {} };

        for (const filePath of files) {
            const uri = pathToUri(filePath);
            const content = this.fileContents.get(uri);
            if (!content) continue;

            // Collect definitions and references for this file
            const fileDefs: [string, SymbolDef][] = [];
            for (const [name, def] of this.definitions) {
                if (def.file === uri) fileDefs.push([name, def]);
            }
            const fileRefs: [string, SymbolRef[]][] = [];
            for (const [name, refs] of this.references) {
                const fileOnly = refs.filter(r => r.file === uri);
                if (fileOnly.length > 0) fileRefs.push([name, fileOnly]);
            }

            cache.files[filePath] = {
                hash: contentHash(content),
                definitions: fileDefs,
                references: fileRefs,
            };
        }

        try {
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, JSON.stringify(cache));
        } catch (e) {
            this.log(`Failed to write cache: ${e}`);
        }
    }

    private rebuildIndex(): void {
        this.definitions.clear();
        this.references.clear();

        for (const [uri, tree] of this.trees) {
            this.extractSymbols(uri, tree);
        }
    }

    private extractSymbols(uri: string, tree: Parser.Tree): void {
        let currentGlobal = '';
        let pendingComments: string[] = [];

        for (const lineNode of tree.rootNode.children) {
            // Handle both 'line' and 'final_line' (EOF without newline)
            if (lineNode.type !== 'line' && lineNode.type !== 'final_line') continue;

            // Check if this line is comment-only or blank
            const namedChildren = lineNode.namedChildren;
            const hasComment = namedChildren.length === 1 && namedChildren[0].type === 'comment';
            const isBlank = namedChildren.length === 0;

            if (hasComment) {
                const commentText = namedChildren[0].text;
                // Strip leading ; and optional space
                pendingComments.push(commentText.replace(/^;\s?/, ''));
                continue;
            }

            if (isBlank) {
                // Blank lines are OK — allow gaps between comments and definitions
                continue;
            }

            // This line has code — attach pending comments to any definition found
            const docComment = pendingComments.length > 0 ? pendingComments.join('\n') : undefined;
            pendingComments = [];

            for (const child of namedChildren) {
                if (child.type === 'label_definition') {
                    this.extractLabel(uri, child, currentGlobal, docComment);
                    const labelNode = child.firstChild;
                    if (labelNode?.type === 'global_label') {
                        const nameNode = labelNode.childForFieldName('name');
                        if (nameNode) currentGlobal = nameNode.text;
                    }
                } else if (child.type === 'statement') {
                    for (const stmt of child.children) {
                        this.processStatement(uri, stmt, currentGlobal, docComment);
                    }
                } else if (child.type === 'directive') {
                    this.extractDirectiveSymbols(uri, child, currentGlobal, docComment);
                } else if (child.type === 'instruction') {
                    this.extractReferences(uri, child, currentGlobal);
                } else if (child.type === 'macro_invocation') {
                    this.extractReferences(uri, child, currentGlobal);
                }
            }
        }
    }

    private processStatement(uri: string, node: Parser.SyntaxNode, currentGlobal: string, docComment?: string): void {
        if (node.type === 'directive') {
            this.extractDirectiveSymbols(uri, node, currentGlobal, docComment);
        } else if (node.type === 'instruction') {
            this.extractReferences(uri, node, currentGlobal);
        } else if (node.type === 'macro_invocation') {
            this.extractReferences(uri, node, currentGlobal);
        }
    }

    private extractLabel(uri: string, node: Parser.SyntaxNode, currentGlobal: string, docComment?: string): void {
        const labelNode = node.firstChild;
        if (!labelNode) return;

        if (labelNode.type === 'global_label') {
            const nameNode = labelNode.childForFieldName('name');
            if (!nameNode) return;
            const name = nameNode.text;
            this.definitions.set(name, {
                name,
                type: 'label',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: false,
                isExported: labelNode.children.some(c => c.text === '::'),
                docComment,
            });
        } else if (labelNode.type === 'local_label') {
            const nameNode = labelNode.childForFieldName('name');
            if (!nameNode) return;
            const localName = nameNode.text; // .something
            const scopedName = currentGlobal ? `${currentGlobal}${localName}` : localName;
            this.definitions.set(scopedName, {
                name: scopedName,
                type: 'label',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: true,
                isExported: false,
                parentLabel: currentGlobal || undefined,
                docComment,
            });
        }
    }

    private extractDirectiveSymbols(uri: string, node: Parser.SyntaxNode, currentGlobal: string, docComment?: string): void {
        const directive = node.firstChild;
        if (!directive) return;

        if (directive.type === 'constant_directive') {
            const nameNode = directive.childForFieldName('name');
            if (!nameNode) return;
            const name = nameNode.text;
            // Extract the value expression text
            const exprNode = directive.namedChildren.find(c => c.type === 'expression');
            const value = exprNode?.text;
            this.definitions.set(name, {
                name,
                type: 'constant',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: false,
                isExported: false,
                docComment,
                value,
            });
            // Extract references from the value expression
            for (const child of directive.children) {
                if (child.type === 'expression') {
                    this.extractReferences(uri, child, currentGlobal);
                }
            }
        } else if (directive.type === 'macro_start') {
            const nameNode = directive.childForFieldName('name');
            if (!nameNode) return;
            this.definitions.set(nameNode.text, {
                name: nameNode.text,
                type: 'macro',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: false,
                isExported: false,
                docComment,
            });
        } else if (directive.type === 'section_directive') {
            // Extract section name from the string
            const stringNode = directive.children.find(c => c.type === 'string');
            if (stringNode) {
                const rawText = stringNode.text;
                const name = rawText.slice(1, -1); // strip quotes
                this.definitions.set(name, {
                    name,
                    type: 'section',
                    file: uri,
                    line: stringNode.startPosition.row,
                    col: stringNode.startPosition.column,
                    endCol: stringNode.endPosition.column,
                    isLocal: false,
                    isExported: false,
                    docComment,
                });
            }
            // Extract references from expressions in section
            this.extractChildReferences(uri, directive, currentGlobal);
        } else if (directive.type === 'data_directive' || directive.type === 'if_directive' ||
                   directive.type === 'elif_directive' || directive.type === 'rept_directive' ||
                   directive.type === 'assert_directive') {
            this.extractChildReferences(uri, directive, currentGlobal);
        } else if (directive.type === 'include_directive') {
            // No symbol extraction needed for includes
        } else {
            // For other directives, scan for symbol references
            this.extractChildReferences(uri, directive, currentGlobal);
        }
    }

    private extractChildReferences(uri: string, node: Parser.SyntaxNode, currentGlobal: string): void {
        for (const child of node.children) {
            this.extractReferences(uri, child, currentGlobal);
        }
    }

    private extractReferences(uri: string, node: Parser.SyntaxNode, currentGlobal: string): void {
        if (node.type === 'symbol_reference') {
            this.extractSymbolRef(uri, node, currentGlobal);
            return;
        }

        for (const child of node.children) {
            this.extractReferences(uri, child, currentGlobal);
        }
    }

    private extractSymbolRef(uri: string, node: Parser.SyntaxNode, currentGlobal: string): void {
        // symbol_reference can be: identifier, local_identifier, identifier+local_identifier, or anonymous ref
        const children = node.children;

        if (children.length === 2 && children[0].type === 'identifier' && children[1].type === 'local_identifier') {
            // GlobalLabel.local form
            const fullName = children[0].text + children[1].text;
            this.addRef(fullName, {
                name: fullName,
                file: uri,
                line: node.startPosition.row,
                col: node.startPosition.column,
                endCol: node.endPosition.column,
            });
            // Also add ref to the global part
            this.addRef(children[0].text, {
                name: children[0].text,
                file: uri,
                line: children[0].startPosition.row,
                col: children[0].startPosition.column,
                endCol: children[0].endPosition.column,
            });
        } else if (children.length === 1) {
            const child = children[0];
            if (child.type === 'identifier') {
                this.addRef(child.text, {
                    name: child.text,
                    file: uri,
                    line: child.startPosition.row,
                    col: child.startPosition.column,
                    endCol: child.endPosition.column,
                });
            } else if (child.type === 'local_identifier') {
                const localName = child.text;
                const scopedName = currentGlobal ? `${currentGlobal}${localName}` : localName;
                this.addRef(scopedName, {
                    name: scopedName,
                    file: uri,
                    line: child.startPosition.row,
                    col: child.startPosition.column,
                    endCol: child.endPosition.column,
                });
            }
        }
    }

    private addRef(name: string, ref: SymbolRef): void {
        let refs = this.references.get(name);
        if (!refs) {
            refs = [];
            this.references.set(name, refs);
        }
        // Avoid duplicates on same line/col
        if (!refs.some(r => r.file === ref.file && r.line === ref.line && r.col === ref.col)) {
            refs.push(ref);
        }
    }
}

export const rgbdsIndexer = new Indexer();
