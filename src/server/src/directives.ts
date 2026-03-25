export interface DirectiveDoc {
    name: string;
    syntax: string;
    description: string;
}

export const DIRECTIVE_DOCS: Map<string, DirectiveDoc> = new Map([
    // ─── Sections ────────────────────────────────────────────────
    ['section', {
        name: 'SECTION',
        syntax: 'SECTION "name", type[bank], options...',
        description: 'Declare a new section. Types: ROM0, ROMX, VRAM, SRAM, WRAM0, WRAMX, OAM, HRAM. Options: BANK[], ALIGN[], ORG[].',
    }],
    ['load', {
        name: 'LOAD',
        syntax: 'LOAD "name", type[bank], options...',
        description: 'Begin a LOAD block — code assembled at one address but intended to run at another (e.g. ROM code copied to WRAM).',
    }],
    ['endl', {
        name: 'ENDL',
        syntax: 'ENDL',
        description: 'End a LOAD block.',
    }],
    ['endsection', {
        name: 'ENDSECTION',
        syntax: 'ENDSECTION',
        description: 'Explicitly close the current section.',
    }],

    // ─── Data ────────────────────────────────────────────────────
    ['db', {
        name: 'DB',
        syntax: 'DB expr, expr, "string"...',
        description: 'Define byte(s). Each expression is truncated to 8 bits. Strings are expanded to individual bytes via the current charmap.',
    }],
    ['dw', {
        name: 'DW',
        syntax: 'DW expr, expr...',
        description: 'Define word(s) (16-bit, little-endian).',
    }],
    ['dl', {
        name: 'DL',
        syntax: 'DL expr, expr...',
        description: 'Define long(s) (32-bit, little-endian).',
    }],
    ['ds', {
        name: 'DS',
        syntax: 'DS count[, value]',
        description: 'Define space — emit `count` bytes, optionally filled with `value` (default 0).',
    }],

    // ─── Constants ───────────────────────────────────────────────
    ['equ', {
        name: 'EQU',
        syntax: 'name EQU expr',
        description: 'Define a numeric constant. Cannot be redefined.',
    }],
    ['equs', {
        name: 'EQUS',
        syntax: 'name EQUS "string"',
        description: 'Define a string constant (text macro). Expanded inline wherever the name appears.',
    }],
    ['set', {
        name: 'SET',
        syntax: 'name = expr  /  name SET expr',
        description: 'Define or redefine a mutable numeric constant.',
    }],
    ['=', {
        name: '= (SET)',
        syntax: 'name = expr',
        description: 'Shorthand for SET — define or redefine a mutable numeric constant.',
    }],
    ['def', {
        name: 'DEF',
        syntax: 'DEF name EQU/EQUS/=/SET expr',
        description: 'Modern syntax for defining constants. Avoids ambiguity with macro invocations.',
    }],
    ['redef', {
        name: 'REDEF',
        syntax: 'REDEF name EQU/EQUS/=/SET expr',
        description: 'Redefine an existing constant.',
    }],

    // ─── RS counters ─────────────────────────────────────────────
    ['rsreset', {
        name: 'RSRESET',
        syntax: 'RSRESET',
        description: 'Reset the RS counter (_RS) to 0.',
    }],
    ['rsset', {
        name: 'RSSET',
        syntax: 'RSSET expr',
        description: 'Set the RS counter (_RS) to `expr`.',
    }],
    ['rb', {
        name: 'RB',
        syntax: 'name RB count',
        description: 'Define a byte-sized RS constant. Sets `name` to current _RS, then advances _RS by `count`.',
    }],
    ['rw', {
        name: 'RW',
        syntax: 'name RW count',
        description: 'Define a word-sized RS constant. Sets `name` to current _RS, then advances _RS by `count * 2`.',
    }],
    ['rl', {
        name: 'RL',
        syntax: 'name RL count',
        description: 'Define a long-sized RS constant. Sets `name` to current _RS, then advances _RS by `count * 4`.',
    }],

    // ─── Includes ────────────────────────────────────────────────
    ['include', {
        name: 'INCLUDE',
        syntax: 'INCLUDE "path"',
        description: 'Include another source file at this point, as if its contents were pasted here.',
    }],
    ['incbin', {
        name: 'INCBIN',
        syntax: 'INCBIN "path"[, offset[, length]]',
        description: 'Include a binary file as raw data bytes. Optionally specify offset and length.',
    }],

    // ─── Exports ─────────────────────────────────────────────────
    ['export', {
        name: 'EXPORT',
        syntax: 'EXPORT name[, name...]',
        description: 'Export symbols so they are visible to other object files during linking.',
    }],
    ['global', {
        name: 'GLOBAL',
        syntax: 'GLOBAL name[, name...]',
        description: 'Alias for EXPORT.',
    }],
    ['purge', {
        name: 'PURGE',
        syntax: 'PURGE name[, name...]',
        description: 'Remove symbol definitions, allowing the names to be reused.',
    }],

    // ─── Macros ──────────────────────────────────────────────────
    ['macro', {
        name: 'MACRO',
        syntax: 'name: MACRO\n  ...\nENDM',
        description: 'Define a macro. Arguments are accessed via \\1, \\2, etc. Use SHIFT to consume arguments.',
    }],
    ['endm', {
        name: 'ENDM',
        syntax: 'ENDM',
        description: 'End a macro definition.',
    }],
    ['shift', {
        name: 'SHIFT',
        syntax: 'SHIFT [count]',
        description: 'Shift macro arguments — \\1 becomes \\2, \\2 becomes \\3, etc. Optional count shifts multiple times.',
    }],

    // ─── Conditionals ────────────────────────────────────────────
    ['if', {
        name: 'IF',
        syntax: 'IF expr',
        description: 'Conditional assembly — assemble the following block only if `expr` is non-zero.',
    }],
    ['elif', {
        name: 'ELIF',
        syntax: 'ELIF expr',
        description: 'Else-if branch — assemble if previous IF/ELIF was false and `expr` is non-zero.',
    }],
    ['else', {
        name: 'ELSE',
        syntax: 'ELSE',
        description: 'Else branch — assemble if all previous IF/ELIF conditions were false.',
    }],
    ['endc', {
        name: 'ENDC',
        syntax: 'ENDC',
        description: 'End a conditional (IF/ELIF/ELSE) block.',
    }],

    // ─── Loops ───────────────────────────────────────────────────
    ['rept', {
        name: 'REPT',
        syntax: 'REPT count\n  ...\nENDR',
        description: 'Repeat a block `count` times. The counter `_NARG` is not affected.',
    }],
    ['for', {
        name: 'FOR',
        syntax: 'FOR var, start, stop[, step]\n  ...\nENDR',
        description: 'Loop with a counter variable from `start` to `stop` (exclusive), incrementing by `step`.',
    }],
    ['endr', {
        name: 'ENDR',
        syntax: 'ENDR',
        description: 'End a REPT or FOR loop.',
    }],
    ['break', {
        name: 'BREAK',
        syntax: 'BREAK',
        description: 'Exit the innermost REPT or FOR loop early.',
    }],

    // ─── Unions ──────────────────────────────────────────────────
    ['union', {
        name: 'UNION',
        syntax: 'UNION',
        description: 'Begin a union — overlapping memory regions that share the same base address.',
    }],
    ['nextu', {
        name: 'NEXTU',
        syntax: 'NEXTU',
        description: 'Begin the next member of a union.',
    }],
    ['endu', {
        name: 'ENDU',
        syntax: 'ENDU',
        description: 'End a union block.',
    }],

    // ─── Charmap ─────────────────────────────────────────────────
    ['charmap', {
        name: 'CHARMAP',
        syntax: 'CHARMAP "string", value',
        description: 'Map a character string to a byte value in the current charmap. Used by DB to convert strings to custom encodings.',
    }],
    ['newcharmap', {
        name: 'NEWCHARMAP',
        syntax: 'NEWCHARMAP name[, base]',
        description: 'Create a new charmap, optionally copying from an existing one.',
    }],
    ['setcharmap', {
        name: 'SETCHARMAP',
        syntax: 'SETCHARMAP name',
        description: 'Switch to a previously defined charmap.',
    }],
    ['pushc', {
        name: 'PUSHC',
        syntax: 'PUSHC',
        description: 'Push the current charmap onto the charmap stack.',
    }],
    ['popc', {
        name: 'POPC',
        syntax: 'POPC',
        description: 'Pop and restore the charmap from the charmap stack.',
    }],

    // ─── Stacks ──────────────────────────────────────────────────
    ['pushs', {
        name: 'PUSHS',
        syntax: 'PUSHS',
        description: 'Push the current section context onto the section stack.',
    }],
    ['pops', {
        name: 'POPS',
        syntax: 'POPS',
        description: 'Pop and restore the section context from the section stack.',
    }],
    ['pusho', {
        name: 'PUSHO',
        syntax: 'PUSHO',
        description: 'Push the current options onto the option stack.',
    }],
    ['popo', {
        name: 'POPO',
        syntax: 'POPO',
        description: 'Pop and restore options from the option stack.',
    }],
    ['opt', {
        name: 'OPT',
        syntax: 'OPT option[, option...]',
        description: 'Set assembler options inline (e.g. `OPT b.X` to change binary prefix display).',
    }],

    // ─── Assertions / Output ─────────────────────────────────────
    ['assert', {
        name: 'ASSERT',
        syntax: 'ASSERT expr[, "message"]',
        description: 'Assert that `expr` is non-zero at assembly time. Produces an error otherwise.',
    }],
    ['static_assert', {
        name: 'STATIC_ASSERT',
        syntax: 'STATIC_ASSERT expr[, "message"]',
        description: 'Assert that `expr` is non-zero at link time.',
    }],
    ['print', {
        name: 'PRINT',
        syntax: 'PRINT expr / "string"[, ...]',
        description: 'Print values to stdout during assembly.',
    }],
    ['warn', {
        name: 'WARN',
        syntax: 'WARN "message"',
        description: 'Emit a warning message during assembly.',
    }],
    ['fail', {
        name: 'FAIL',
        syntax: 'FAIL "message"',
        description: 'Emit an error message and stop assembly.',
    }],
]);
