import { describe, it, expect, beforeEach } from 'vitest';
import { stripQuotes, parseNumberLiteral } from '../src/utils';
import { Indexer } from '../src/indexer';

// ---------------------------------------------------------------------------
// stripQuotes
// ---------------------------------------------------------------------------

describe('stripQuotes', () => {
    it('strips regular double-quoted string', () => {
        expect(stripQuotes('"hello"')).toBe('hello');
    });

    it('strips triple-quoted string', () => {
        expect(stripQuotes('"""hello"""')).toBe('hello');
    });

    it('strips #-prefixed string', () => {
        expect(stripQuotes('#"hello"')).toBe('hello');
    });

    it('strips empty double-quoted string', () => {
        expect(stripQuotes('""')).toBe('');
    });

    it('strips single-character double-quoted string', () => {
        expect(stripQuotes('"a"')).toBe('a');
    });
});

// ---------------------------------------------------------------------------
// Per-file index population
// ---------------------------------------------------------------------------

describe('Indexer per-file index', () => {
    let indexer: Indexer;

    beforeEach(() => {
        indexer = new Indexer();
    });

    it('populates fileDefinitions after indexing a file', () => {
        const uri = 'file:///test/example.asm';
        const content = [
            'SECTION "Main", ROM0',
            'MyLabel:',
            '    ld a, 0',
            'MY_CONST EQU 42',
        ].join('\n');

        indexer.indexFile(uri, content);

        const defs = indexer.fileDefinitions.get(uri);
        expect(defs).toBeDefined();
        expect(defs!.has('MyLabel')).toBe(true);
        expect(defs!.has('MY_CONST')).toBe(true);
    });

    it('populates fileReferences after indexing a file', () => {
        const uri = 'file:///test/example.asm';
        const content = [
            'SECTION "Main", ROM0',
            'MyLabel:',
            '    call OtherLabel',
            'OtherLabel:',
            '    ret',
        ].join('\n');

        indexer.indexFile(uri, content);

        const refs = indexer.fileReferences.get(uri);
        expect(refs).toBeDefined();
        expect(refs!.has('OtherLabel')).toBe(true);
    });

    it('clears old entries and populates new ones on re-index', () => {
        const uri = 'file:///test/example.asm';

        const initialContent = [
            'SECTION "Main", ROM0',
            'OldLabel:',
            '    ld a, 0',
            'OLD_CONST EQU 10',
        ].join('\n');

        indexer.indexFile(uri, initialContent);

        // Verify initial state
        const defsBefore = indexer.fileDefinitions.get(uri);
        expect(defsBefore!.has('OldLabel')).toBe(true);
        expect(defsBefore!.has('OLD_CONST')).toBe(true);

        // Re-index with completely different content
        const newContent = [
            'SECTION "Main", ROM0',
            'NewLabel:',
            '    ld a, 0',
            'NEW_CONST EQU 99',
        ].join('\n');

        indexer.indexFile(uri, newContent);

        const defsAfter = indexer.fileDefinitions.get(uri);
        expect(defsAfter).toBeDefined();

        // Old symbols should be gone
        expect(indexer.definitions.has('OldLabel')).toBe(false);
        expect(indexer.definitions.has('OLD_CONST')).toBe(false);

        // New symbols should be present
        expect(defsAfter!.has('NewLabel')).toBe(true);
        expect(defsAfter!.has('NEW_CONST')).toBe(true);
        expect(indexer.definitions.has('NewLabel')).toBe(true);
        expect(indexer.definitions.has('NEW_CONST')).toBe(true);
    });

    it('does not lose symbols from other files when re-indexing one file', () => {
        const uriA = 'file:///test/a.asm';
        const uriB = 'file:///test/b.asm';

        indexer.indexFile(uriA, [
            'SECTION "A", ROM0',
            'LabelA:',
            '    ret',
        ].join('\n'));

        indexer.indexFile(uriB, [
            'SECTION "B", ROM0',
            'LabelB:',
            '    ret',
        ].join('\n'));

        // Verify both present
        expect(indexer.definitions.has('LabelA')).toBe(true);
        expect(indexer.definitions.has('LabelB')).toBe(true);

        // Re-index file A only
        indexer.indexFile(uriA, [
            'SECTION "A", ROM0',
            'LabelA:',
            '    nop',
        ].join('\n'));

        // LabelB from file B must still be in the index
        expect(indexer.definitions.has('LabelA')).toBe(true);
        expect(indexer.definitions.has('LabelB')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// allDefinitions (duplicate tracking)
// ---------------------------------------------------------------------------

describe('Indexer allDefinitions', () => {
    it('tracks all definitions including duplicates', () => {
        const indexer = new Indexer();
        indexer.indexFile('file:///a.asm', 'MyLabel:\n    ret');
        indexer.indexFile('file:///b.asm', 'MyLabel:\n    ret');

        const allDefs = indexer.allDefinitions.get('MyLabel');
        expect(allDefs).toBeDefined();
        expect(allDefs!.length).toBe(2);
        expect(allDefs!.map(d => d.file)).toContain('file:///a.asm');
        expect(allDefs!.map(d => d.file)).toContain('file:///b.asm');
    });

    it('cleans up allDefinitions on reindex', () => {
        const indexer = new Indexer();
        indexer.indexFile('file:///a.asm', 'OldLabel:\n    ret');
        indexer.indexFile('file:///a.asm', 'NewLabel:\n    ret');

        expect(indexer.allDefinitions.has('OldLabel')).toBe(false);
        expect(indexer.allDefinitions.has('NewLabel')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// removeFolder
// ---------------------------------------------------------------------------

describe('Indexer removeFolder', () => {
    it('removes all symbols from a folder', () => {
        const indexer = new Indexer();
        // Use paths without leading slash so pathToUri produces matching file:/// URIs
        indexer.indexFile('file:///project/src/a.asm', 'LabelA:\n    ret');
        indexer.indexFile('file:///project/src/b.asm', 'LabelB:\n    ret');
        indexer.indexFile('file:///other/c.asm', 'LabelC:\n    ret');

        // removeFolder uses pathToUri internally; pass a path that converts to 'file:///project/src'
        indexer.removeFolder('project/src');

        expect(indexer.definitions.has('LabelA')).toBe(false);
        expect(indexer.definitions.has('LabelB')).toBe(false);
        expect(indexer.definitions.has('LabelC')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Charmap type
// ---------------------------------------------------------------------------

describe('Indexer charmap type', () => {
    it('stores NEWCHARMAP as charmap type', () => {
        const indexer = new Indexer();
        indexer.indexFile('file:///test.asm', 'NEWCHARMAP mymap');

        const def = indexer.definitions.get('mymap');
        expect(def).toBeDefined();
        expect(def!.type).toBe('charmap');
    });
});

// ---------------------------------------------------------------------------
// Local label scoping
// ---------------------------------------------------------------------------

describe('Indexer local label scoping', () => {
    it('scopes local labels to their parent global label', () => {
        const indexer = new Indexer();
        indexer.indexFile('file:///test.asm', [
            'GlobalA:',
            '.local:',
            '    ret',
            'GlobalB:',
            '.local:',
            '    ret',
        ].join('\n'));

        expect(indexer.definitions.has('GlobalA.local')).toBe(true);
        expect(indexer.definitions.has('GlobalB.local')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// parseNumberLiteral
// ---------------------------------------------------------------------------

describe('parseNumberLiteral', () => {
    it('parses hex with $ prefix', () => {
        const result = parseNumberLiteral('$FF');
        expect(result).not.toBeNull();
        expect(result!.value).toBe(255);
    });

    it('parses hex with 0x prefix', () => {
        const result = parseNumberLiteral('0xFF');
        expect(result).not.toBeNull();
        expect(result!.value).toBe(255);
    });

    it('parses binary with % prefix', () => {
        const result = parseNumberLiteral('%1010');
        expect(result).not.toBeNull();
        expect(result!.value).toBe(10);
    });

    it('parses decimal', () => {
        const result = parseNumberLiteral('42');
        expect(result).not.toBeNull();
        expect(result!.value).toBe(42);
    });

    it('returns null for non-numeric', () => {
        expect(parseNumberLiteral('hello')).toBeNull();
    });
});
