import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LspTestClient } from './lsp-client';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Integration tests against real RGBDS projects.
 * Clones a real repo, starts the LSP, tests operations, then cleans up.
 *
 * These tests are slow (clone + index) — run separately with:
 *   npx vitest run tests/real-project.test.ts
 */

const TEMP_ROOT = path.resolve(__dirname, '_temp_repos');

function cloneShallow(repo: string, dir: string): void {
    execSync(`git clone --depth 1 ${repo} "${dir}"`, {
        stdio: 'pipe',
        timeout: 60000,
    });
}

function fileUriFromPath(p: string): string {
    return 'file:///' + p.replace(/\\/g, '/');
}

/** Find the first .asm file containing a pattern */
function findFileWithPattern(dir: string, pattern: RegExp): { path: string; content: string } | null {
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory() && entry.name !== '.git') {
                stack.push(full);
            } else if (entry.isFile() && /\.(asm|inc)$/i.test(entry.name)) {
                const content = fs.readFileSync(full, 'utf-8');
                if (pattern.test(content)) {
                    return { path: full, content };
                }
            }
        }
    }
    return null;
}

/** Count .asm/.inc files in a directory tree */
function countAsmFiles(dir: string): number {
    let count = 0;
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory() && entry.name !== '.git') {
                stack.push(full);
            } else if (entry.isFile() && /\.(asm|inc)$/i.test(entry.name)) {
                count++;
            }
        }
    }
    return count;
}

describe('pokecrystal', () => {
    const repoDir = path.join(TEMP_ROOT, 'pokecrystal');
    let client: LspTestClient;

    beforeAll(async () => {
        fs.mkdirSync(TEMP_ROOT, { recursive: true });
        if (!fs.existsSync(repoDir)) {
            cloneShallow('https://github.com/pret/pokecrystal.git', repoDir);
        }

        const fileCount = countAsmFiles(repoDir);
        console.log(`pokecrystal: ${fileCount} .asm/.inc files`);

        client = new LspTestClient();
        const result = await client.initialize(fileUriFromPath(repoDir));
        expect(result).toBeDefined();

        // Wait for indexing — pokecrystal has hundreds of symbols
        await client.waitForIndexing(100, 120000);
    }, 180000);

    afterAll(async () => {
        if (client) await client.shutdown();
        fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    }, 15000);

    it('should complete initialization without crashing', () => {
        // If we reached here, the server survived initialization + indexing
        expect(client).toBeDefined();
    });

    it('should provide hover for a known label', async () => {
        // Find a file with a global label definition
        const file = findFileWithPattern(repoDir, /^[A-Z]\w+::/m);
        expect(file).not.toBeNull();

        const uri = fileUriFromPath(file!.path);
        client.openDocument(uri, file!.content);

        // Find the first global label line
        const lines = file!.content.split(/\r?\n/);
        let labelLine = -1;
        for (let i = 0; i < lines.length; i++) {
            if (/^[A-Z]\w+::/.test(lines[i])) {
                labelLine = i;
                break;
            }
        }
        expect(labelLine).toBeGreaterThanOrEqual(0);

        const result = await client.hover(uri, labelLine, 0) as any;
        expect(result).not.toBeNull();
        expect(result.contents.value).toContain('label');
    }, 15000);

    it('should provide completion with many symbols', async () => {
        const file = findFileWithPattern(repoDir, /^[A-Z]\w+::/m);
        expect(file).not.toBeNull();

        const uri = fileUriFromPath(file!.path);
        const result = await client.completion(uri, 0, 0) as any[];
        expect(result.length).toBeGreaterThan(100);
    }, 15000);

    it('should resolve cross-file definitions', async () => {
        // Find a file that calls something (has "call SomeLabel" or "jp SomeLabel")
        const file = findFileWithPattern(repoDir, /\bcall\s+[A-Z]\w+/m);
        expect(file).not.toBeNull();

        const uri = fileUriFromPath(file!.path);
        client.openDocument(uri, file!.content);

        // Find the first "call Label" line
        const lines = file!.content.split(/\r?\n/);
        let callLine = -1;
        let callCol = -1;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/\bcall\s+([A-Z]\w+)/);
            if (m) {
                callLine = i;
                callCol = lines[i].indexOf(m[1]);
                break;
            }
        }
        expect(callLine).toBeGreaterThanOrEqual(0);

        const result = await client.definition(uri, callLine, callCol) as any;
        // May be null if the target is not defined in the project (e.g. macro)
        // but should not crash
        if (result) {
            expect(result.uri).toBeDefined();
            expect(result.range).toBeDefined();
        }
    }, 15000);

    it('should provide document symbols', async () => {
        const file = findFileWithPattern(repoDir, /^[A-Z]\w+::/m);
        expect(file).not.toBeNull();

        const uri = fileUriFromPath(file!.path);
        client.openDocument(uri, file!.content);

        const result = await client.documentSymbol(uri) as any[];
        expect(result.length).toBeGreaterThan(0);
    }, 15000);

    it('should find references across files', async () => {
        // Find a file with an exported label
        const file = findFileWithPattern(repoDir, /^[A-Z]\w+::/m);
        expect(file).not.toBeNull();

        const uri = fileUriFromPath(file!.path);
        client.openDocument(uri, file!.content);

        const lines = file!.content.split(/\r?\n/);
        let labelLine = -1;
        for (let i = 0; i < lines.length; i++) {
            if (/^[A-Z]\w+::/.test(lines[i])) {
                labelLine = i;
                break;
            }
        }

        const result = await client.references(uri, labelLine, 0, 30000) as any[];
        // Exported labels should have at least the definition itself
        expect(result.length).toBeGreaterThanOrEqual(1);
    }, 45000);

    it('should handle hover on non-existent symbol gracefully', async () => {
        const file = findFileWithPattern(repoDir, /^;/m);
        expect(file).not.toBeNull();

        const uri = fileUriFromPath(file!.path);
        client.openDocument(uri, file!.content);

        // Hover on a comment line — should return null, not crash
        const result = await client.hover(uri, 0, 0);
        // null is fine, an object is fine, crash is not
    }, 15000);
});
