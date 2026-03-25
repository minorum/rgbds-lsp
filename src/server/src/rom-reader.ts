import * as fs from 'fs';
import * as path from 'path';

export interface SymEntry {
    bank: number;
    address: number;
    name: string;
}

export interface RomData {
    symEntries: Map<string, SymEntry>;
    romBuffer: Buffer;
    romPath: string;
    symPath: string;
    romMtime: number;
    symMtime: number;
}

export class RomReader {
    private cache: RomData | null = null;

    parseSym(content: string): Map<string, SymEntry> {
        const entries = new Map<string, SymEntry>();
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(';')) continue;
            // Format: BB:AAAA SymbolName
            const match = trimmed.match(/^([0-9a-fA-F]+):([0-9a-fA-F]+)\s+(.+)$/);
            if (!match) continue;
            const bank = parseInt(match[1], 16);
            const address = parseInt(match[2], 16);
            const name = match[3].trim();
            entries.set(name, { bank, address, name });
        }
        return entries;
    }

    toRomOffset(bank: number, address: number): number {
        // Only ROM addresses (0x0000-0x7FFF) map to the ROM file
        if (address >= 0x8000) return -1;
        if (bank === 0) return address;
        return bank * 0x4000 + (address - 0x4000);
    }

    readBytes(romBuffer: Buffer, romOffset: number, count: number): number[] {
        if (romOffset < 0 || romOffset + count > romBuffer.length || count <= 0) return [];
        const bytes: number[] = [];
        for (let i = 0; i < count; i++) {
            bytes.push(romBuffer[romOffset + i]);
        }
        return bytes;
    }

    load(romPath: string, symPath: string): RomData | null {
        try {
            const romStat = fs.statSync(romPath);
            const symStat = fs.statSync(symPath);

            // Return cache if files haven't changed
            if (this.cache
                && this.cache.romPath === romPath
                && this.cache.symPath === symPath
                && this.cache.romMtime === romStat.mtimeMs
                && this.cache.symMtime === symStat.mtimeMs) {
                return this.cache;
            }

            const romBuffer = fs.readFileSync(romPath);
            const symContent = fs.readFileSync(symPath, 'utf-8');
            const symEntries = this.parseSym(symContent);

            this.cache = {
                symEntries,
                romBuffer,
                romPath,
                symPath,
                romMtime: romStat.mtimeMs,
                symMtime: symStat.mtimeMs,
            };
            return this.cache;
        } catch {
            return null;
        }
    }

    autoDetect(workspaceRoot: string): { romPath: string; symPath: string } | null {
        // Check workspace root and common build directories
        const searchDirs = [workspaceRoot];
        for (const sub of ['build', 'bin', 'out', 'rom']) {
            const dir = path.join(workspaceRoot, sub);
            try { if (fs.statSync(dir).isDirectory()) searchDirs.push(dir); } catch {}
        }

        for (const dir of searchDirs) {
            const result = this.detectInDir(dir);
            if (result) return result;
        }
        return null;
    }

    private detectInDir(dir: string): { romPath: string; symPath: string } | null {
        try {
            const files = fs.readdirSync(dir);
            const romFiles = files.filter(f => /\.(gb|gbc)$/i.test(f));
            const symFiles = files.filter(f => /\.sym$/i.test(f));

            if (romFiles.length === 0 || symFiles.length === 0) return null;

            // Prefer matching basenames (e.g., game.gb + game.sym)
            for (const rom of romFiles) {
                const base = path.basename(rom, path.extname(rom));
                const matchingSym = symFiles.find(s => path.basename(s, '.sym') === base);
                if (matchingSym) {
                    return {
                        romPath: path.join(dir, rom),
                        symPath: path.join(dir, matchingSym),
                    };
                }
            }

            // Fall back to newest ROM + newest sym
            const newest = (d: string, list: string[]) =>
                list.sort((a, b) => {
                    try {
                        return fs.statSync(path.join(d, b)).mtimeMs - fs.statSync(path.join(d, a)).mtimeMs;
                    } catch { return 0; }
                })[0];

            return {
                romPath: path.join(dir, newest(dir, romFiles)),
                symPath: path.join(dir, newest(dir, symFiles)),
            };
        } catch {
            return null;
        }
    }

    invalidate(): void {
        this.cache = null;
    }
}
