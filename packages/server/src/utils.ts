import * as path from 'path';
import * as fs from 'fs';

export function uriToPath(uri: string): string {
    if (uri.startsWith('file:///')) {
        let p = decodeURIComponent(uri.substring(8));
        if (path.sep === '\\') {
            p = p.replace(/\//g, '\\');
        }
        return p;
    }
    return uri;
}

export function pathToUri(filePath: string): string {
    if (!filePath) return '';
    if (filePath.startsWith('file://')) return filePath;
    return 'file:///' + filePath.replace(/\\/g, '/');
}

export function collectRgbdsFiles(rootDir: string): string[] {
    const result: string[] = [];
    const stack = [rootDir];

    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (ext === '.asm' || ext === '.inc') {
                    result.push(fullPath);
                }
            }
        }
    }

    return result;
}
