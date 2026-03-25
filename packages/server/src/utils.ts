import * as path from 'path';
import * as fs from 'fs';
import Parser from 'tree-sitter';

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

export function getNodeAtPosition(tree: Parser.Tree, line: number, col: number): Parser.SyntaxNode {
    return tree.rootNode.descendantForPosition({ row: line, column: col });
}

export interface NumberValue {
    value: number;
    decimal: string;
    hex: string;
    binary: string;
    octal: string;
    isFixedPoint?: boolean;
}

export function parseNumberLiteral(text: string): NumberValue | null {
    let value: number;

    // Fixed-point: e.g. 1.5q8
    const fixedMatch = text.match(/^(\d+)\.(\d+)[qQ](\d+)$/);
    if (fixedMatch) {
        const int = parseInt(fixedMatch[1], 10);
        const frac = parseInt(fixedMatch[2], 10);
        const bits = parseInt(fixedMatch[3], 10);
        value = int + frac / (1 << bits);
        return {
            value,
            decimal: `${value}`,
            hex: `(fixed-point)`,
            binary: `(fixed-point)`,
            octal: `(fixed-point)`,
            isFixedPoint: true,
        };
    }

    const cleaned = text.replace(/_/g, '');

    if (cleaned.startsWith('$') || cleaned.toLowerCase().startsWith('0x')) {
        const hex = cleaned.startsWith('$') ? cleaned.substring(1) : cleaned.substring(2);
        value = parseInt(hex, 16);
    } else if (cleaned.startsWith('%') || cleaned.toLowerCase().startsWith('0b')) {
        const bin = cleaned.startsWith('%') ? cleaned.substring(1) : cleaned.substring(2);
        value = parseInt(bin, 2);
    } else if (cleaned.startsWith('&') || cleaned.toLowerCase().startsWith('0o')) {
        const oct = cleaned.startsWith('&') ? cleaned.substring(1) : cleaned.substring(2);
        value = parseInt(oct, 8);
    } else {
        value = parseInt(cleaned, 10);
    }

    if (isNaN(value)) return null;

    return {
        value,
        decimal: value.toString(10),
        hex: '$' + value.toString(16).toUpperCase(),
        binary: '%' + value.toString(2),
        octal: '&' + value.toString(8),
    };
}

/** Strip surrounding quotes from an RGBDS string literal: "...", """...""", or #"..." */
export function stripQuotes(text: string): string {
    if (text.startsWith('#"')) text = text.slice(1); // remove # prefix
    if (text.startsWith('"""') && text.endsWith('"""')) return text.slice(3, -3);
    if (text.length >= 2) return text.slice(1, -1);
    return text;
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
