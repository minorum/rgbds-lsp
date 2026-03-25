import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

interface LspMessage {
    jsonrpc: '2.0';
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
}

/**
 * Minimal LSP client for integration testing.
 * Spawns the language server and communicates via stdio.
 */
export class LspTestClient {
    private server: ChildProcess;
    private buffer = Buffer.alloc(0);
    private pendingRequests = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (err: Error) => void;
    }>();
    private nextId = 1;
    private notifications: LspMessage[] = [];

    constructor() {
        const serverPath = path.resolve(__dirname, '../dist/index.js');
        this.server = spawn('node', [serverPath, '--stdio'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.server.stdout!.on('data', (data: Buffer) => {
            this.buffer = Buffer.concat([this.buffer, data]);
            this.processBuffer();
        });

        this.server.stderr!.on('data', (data: Buffer) => {
            // Capture stderr for debugging but don't fail
            process.stderr.write(`[LSP stderr] ${data.toString()}`);
        });
    }

    private processBuffer(): void {
        while (true) {
            const separator = Buffer.from('\r\n\r\n');
            const headerEnd = this.buffer.indexOf(separator);
            if (headerEnd === -1) return;

            const header = this.buffer.subarray(0, headerEnd).toString();
            const match = header.match(/Content-Length:\s*(\d+)/);
            if (!match) {
                this.buffer = this.buffer.subarray(headerEnd + 4);
                continue;
            }

            const contentLength = parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;
            if (this.buffer.length < bodyStart + contentLength) return;

            const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString();
            this.buffer = this.buffer.subarray(bodyStart + contentLength);

            const msg: LspMessage = JSON.parse(body);
            if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
                const pending = this.pendingRequests.get(msg.id)!;
                this.pendingRequests.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
                } else {
                    pending.resolve(msg.result);
                }
            } else {
                this.notifications.push(msg);
            }
        }
    }

    async request(method: string, params: unknown, timeoutMs = 10000): Promise<unknown> {
        const id = this.nextId++;
        const msg: LspMessage = { jsonrpc: '2.0', id, method, params };
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.send(msg);

            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request ${method} timed out after ${timeoutMs / 1000}s`));
                }
            }, timeoutMs);
        });
    }

    notify(method: string, params: unknown): void {
        this.send({ jsonrpc: '2.0', method, params });
    }

    private send(msg: LspMessage): void {
        const body = JSON.stringify(msg);
        const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
        this.server.stdin!.write(header + body);
    }

    async initialize(rootUri: string): Promise<unknown> {
        const result = await this.request('initialize', {
            processId: process.pid,
            capabilities: {},
            rootUri,
            workspaceFolders: [{ uri: rootUri, name: 'test' }],
        });
        this.notify('initialized', {});
        return result;
    }

    openDocument(uri: string, text: string): void {
        this.notify('textDocument/didOpen', {
            textDocument: { uri, languageId: 'asm', version: 1, text },
        });
    }

    async hover(uri: string, line: number, character: number): Promise<unknown> {
        return this.request('textDocument/hover', {
            textDocument: { uri },
            position: { line, character },
        });
    }

    async definition(uri: string, line: number, character: number): Promise<unknown> {
        return this.request('textDocument/definition', {
            textDocument: { uri },
            position: { line, character },
        });
    }

    async references(uri: string, line: number, character: number, timeoutMs?: number): Promise<unknown> {
        return this.request('textDocument/references', {
            textDocument: { uri },
            position: { line, character },
            context: { includeDeclaration: true },
        }, timeoutMs);
    }

    async completion(uri: string, line: number, character: number): Promise<unknown> {
        return this.request('textDocument/completion', {
            textDocument: { uri },
            position: { line, character },
        });
    }

    async documentSymbol(uri: string): Promise<unknown> {
        return this.request('textDocument/documentSymbol', {
            textDocument: { uri },
        });
    }

    async rename(uri: string, line: number, character: number, newName: string): Promise<unknown> {
        return this.request('textDocument/rename', {
            textDocument: { uri },
            position: { line, character },
            newName,
        });
    }

    async diagnostics(uri: string): Promise<unknown[]> {
        // Wait for server to compute diagnostics
        await new Promise(r => setTimeout(r, 500));
        const diags = this.notifications
            .filter(n => n.method === 'textDocument/publishDiagnostics' && (n.params as any).uri === uri)
            .map(n => (n.params as any).diagnostics)
            .flat();
        return diags;
    }

    async inlayHint(uri: string, startLine: number, endLine: number): Promise<unknown> {
        return this.request('textDocument/inlayHint', {
            textDocument: { uri },
            range: {
                start: { line: startLine, character: 0 },
                end: { line: endLine, character: 0 },
            },
        });
    }

    async signatureHelp(uri: string, line: number, character: number): Promise<unknown> {
        return this.request('textDocument/signatureHelp', {
            textDocument: { uri },
            position: { line, character },
        });
    }

    async semanticTokensFull(uri: string): Promise<unknown> {
        return this.request('textDocument/semanticTokens/full', {
            textDocument: { uri },
        });
    }

    async semanticTokensRange(uri: string, startLine: number, endLine: number): Promise<unknown> {
        return this.request('textDocument/semanticTokens/range', {
            textDocument: { uri },
            range: {
                start: { line: startLine, character: 0 },
                end: { line: endLine, character: 0 },
            },
        });
    }

    async foldingRange(uri: string): Promise<unknown> {
        return this.request('textDocument/foldingRange', {
            textDocument: { uri },
        });
    }

    /** Wait for background indexing to finish by polling definitions */
    async waitForIndexing(expectedDefs: number, timeoutMs = 30000): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            // Request completion to check if definitions are available
            const result = await this.completion('file:///dummy.asm', 0, 0) as unknown[];
            if (result && result.length >= expectedDefs) return;
            await new Promise(r => setTimeout(r, 200));
        }
        throw new Error(`Indexing did not complete within ${timeoutMs}ms`);
    }

    async shutdown(): Promise<void> {
        await this.request('shutdown', null);
        this.notify('exit', null);
        return new Promise((resolve) => {
            this.server.on('exit', () => resolve());
            setTimeout(() => {
                this.server.kill();
                resolve();
            }, 2000);
        });
    }
}
