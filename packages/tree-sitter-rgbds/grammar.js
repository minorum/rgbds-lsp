/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// SM83 (Game Boy CPU) instruction mnemonics
const INSTRUCTIONS = [
  'adc', 'add', 'and', 'bit', 'call', 'ccf', 'cp', 'cpl',
  'daa', 'dec', 'di', 'ei', 'halt', 'inc', 'jp', 'jr',
  'ld', 'ldh', 'ldi', 'ldd', 'nop', 'or', 'pop', 'push',
  'res', 'ret', 'reti', 'rl', 'rla', 'rlc', 'rlca',
  'rr', 'rra', 'rrc', 'rrca', 'rst', 'sbc', 'scf',
  'set', 'sla', 'sra', 'srl', 'stop', 'sub', 'swap', 'xor',
];

// Registers (sp handled separately for sp+offset disambiguation)
const REGISTERS = [
  'a', 'b', 'c', 'd', 'e', 'h', 'l',
  'af', 'bc', 'de', 'hl',
];

// Fix #1: Add 'c' as a condition (z, nz, c, nc)
const CONDITIONS = ['z', 'nz', 'c', 'nc'];

module.exports = grammar({
  name: 'rgbds',

  extras: $ => [
    /[ \t\r]/,
    $.block_comment,
    $.line_continuation,  // Fix #9: backslash line continuation
  ],

  word: $ => $.identifier,

  conflicts: $ => [],

  rules: {
    source_file: $ => seq(
      repeat($.line),
      optional($.final_line),  // Fix #11: file without trailing newline
    ),

    // Fix #4: support multiple statements per line with :: separator
    // Fix #11: final_line handles EOF without newline
    line: $ => seq(
      optional($.label_definition),
      optional($.statement),
      repeat(seq('::', $.statement)),
      optional($.comment),
      '\n',
    ),

    final_line: $ => choice(
      seq($.label_definition, optional($.statement), repeat(seq('::', $.statement)), optional($.comment)),
      seq($.statement, repeat(seq('::', $.statement)), optional($.comment)),
      $.comment,
    ),

    statement: $ => choice(
      $.instruction,
      $.directive,
      $.macro_invocation,
    ),

    // Fix #9: line continuation
    line_continuation: _ => token(seq('\\', /\r?\n/)),

    // ─── Comments ─────────────────────────────────────────────

    comment: _ => /;[^\r\n]*/,

    block_comment: _ => token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),

    // ─── Labels ───────────────────────────────────────────────
    // Fix #5/#6: identifiers can contain dots for scoped labels
    // e.g. AnotherGlobal.with_another_local:

    label_definition: $ => choice(
      $.global_label,
      $.local_label,
      $.anonymous_label,
    ),

    global_label: $ => seq(
      field('name', choice($.identifier, $.scoped_identifier)),
      choice('::', ':'),
    ),

    local_label: $ => choice(
      prec(2, seq(field('name', $.local_identifier), '::')),
      prec(2, seq(field('name', $.local_identifier), ':')),
      field('name', $.local_identifier),  // colon-less local label
    ),

    anonymous_label: _ => token(prec(-1, ':')),

    // ─── Instructions ─────────────────────────────────────────

    instruction: $ => seq(
      field('mnemonic', $.mnemonic),
      optional($.operand_list),
    ),

    mnemonic: _ => token(choice(...INSTRUCTIONS.map(i => ci(i)))),

    operand_list: $ => seq(
      $.operand,
      repeat(seq(',', $.operand)),
    ),

    operand: $ => choice(
      $.sp_offset,             // sp+n (must come first)
      $.sp_register,           // standalone sp
      $.negated_condition,     // Fix #2: !cc
      $.register,
      $.condition,
      $.memory_operand,
      $.expression,
    ),

    // Fix #3: sp_offset restricted to literal 'sp' only
    sp_offset: $ => prec(2, seq(
      $.sp_register,
      choice('+', '-'),
      $.expression,
    )),

    // sp is separate from register to allow sp_offset disambiguation
    sp_register: _ => token(ci('sp')),

    register: _ => token(choice(...REGISTERS.map(r => ci(r)))),

    // Fix #1: 'c' included in conditions
    condition: _ => token(choice(...CONDITIONS.map(c => ci(c)))),

    // Fix #2: negated conditions (!z, !nz, !c, !nc)
    negated_condition: $ => seq('!', $.condition),

    memory_operand: $ => seq(
      '[',
      choice(
        seq($.register, '+'),     // [hl+]
        seq($.register, '-'),     // [hl-]
        $.register,               // [hl], [bc], [de]
        $.sp_register,            // [sp] (rare but valid)
        $.expression,             // [$FF00+c], [$addr]
      ),
      ']',
    ),

    // ─── Directives (flat — block boundaries are just markers) ──

    directive: $ => choice(
      $.section_directive,
      $.data_directive,
      $.constant_directive,
      $.include_directive,
      $.incbin_directive,
      $.export_directive,
      $.purge_directive,
      $.charmap_directive,
      $.newcharmap_directive,
      $.setcharmap_directive,
      $.assert_directive,
      $.print_directive,
      $.warn_directive,
      $.fail_directive,
      $.opt_directive,
      // Block boundary markers (flat, no nesting)
      $.macro_start,
      $.endm_directive,
      $.if_directive,
      $.elif_directive,
      $.else_directive,
      $.endc_directive,
      $.rept_directive,
      $.for_directive,
      $.endr_directive,
      $.break_directive,
      $.shift_directive,
      $.endsection_directive,
      // Fix #7: UNION/NEXTU/ENDU as block markers (also SECTION modifier handled below)
      $.union_directive,
      $.nextu_directive,
      $.endu_directive,
      $.pushs_directive,
      $.pops_directive,
      $.pusho_directive,
      $.popo_directive,
      $.pushc_directive,
      $.popc_directive,
      // Fix #8: LOAD / ENDL
      $.load_directive,
      $.endl_directive,
    ),

    // ─── Section ──────────────────────────────────────────────
    // Fix #7: SECTION supports UNION and FRAGMENT modifiers

    section_directive: $ => seq(
      ci_kw('SECTION'),
      optional(choice(ci_kw('UNION'), ci_kw('FRAGMENT'))),
      $.string,
      ',',
      $.section_type,
      optional(seq('[', $.expression, ']')),
      repeat(seq(',', $.section_option)),
    ),

    section_type: _ => token(choice(
      ci('ROM0'), ci('ROMX'), ci('VRAM'), ci('SRAM'),
      ci('WRAM0'), ci('WRAMX'), ci('OAM'), ci('HRAM'),
    )),

    section_option: $ => choice(
      seq(ci_kw('BANK'), '[', $.expression, ']'),
      seq(ci_kw('ALIGN'), '[', $.expression, optional(seq(',', $.expression)), ']'),
    ),

    endsection_directive: _ => ci_kw('ENDSECTION'),

    // ─── Data ─────────────────────────────────────────────────

    data_directive: $ => seq(
      field('size', choice(ci_kw('DB'), ci_kw('DW'), ci_kw('DL'), ci_kw('DS'))),
      $.expression_list,
    ),

    // ─── Constants ────────────────────────────────────────────

    constant_directive: $ => choice(
      seq(ci_kw('DEF'), field('name', $.identifier), ci_kw('EQU'), $.expression),
      seq(ci_kw('DEF'), field('name', $.identifier), ci_kw('EQUS'), $.expression),
      seq(ci_kw('DEF'), field('name', $.identifier), choice('=', ci_kw('SET')), $.expression),
      seq(ci_kw('REDEF'), field('name', $.identifier), ci_kw('EQUS'), $.expression),
      // Legacy (no DEF prefix)
      seq(field('name', $.identifier), ci_kw('EQU'), $.expression),
      seq(field('name', $.identifier), ci_kw('EQUS'), $.expression),
      seq(field('name', $.identifier), choice('=', ci_kw('SET')), $.expression),
    ),

    // ─── Include / Incbin ─────────────────────────────────────

    include_directive: $ => seq(ci_kw('INCLUDE'), $.string),

    incbin_directive: $ => seq(
      ci_kw('INCBIN'),
      $.string,
      optional(seq(',', $.expression, optional(seq(',', $.expression)))),
    ),

    // ─── Export / Purge ───────────────────────────────────────

    export_directive: $ => seq(
      choice(ci_kw('EXPORT'), ci_kw('GLOBAL')),
      $.identifier,
      repeat(seq(',', $.identifier)),
    ),

    purge_directive: $ => seq(
      ci_kw('PURGE'),
      $.identifier,
      repeat(seq(',', $.identifier)),
    ),

    // ─── Macro (flat boundary markers) ────────────────────────

    macro_start: $ => seq(
      ci_kw('MACRO'),
      field('name', $.identifier),
    ),

    endm_directive: _ => ci_kw('ENDM'),

    // Fix #12: macro_invocation at lowest precedence, only when nothing else matches
    macro_invocation: $ => prec(-2, seq(
      field('name', $.identifier),
      optional($.macro_arg_list),
    )),

    // Macro arguments are less structured than expression_list —
    // they can contain arbitrary text separated by commas
    macro_arg_list: $ => $.expression_list,

    macro_arg: _ => /\\[1-9#@]/,

    shift_directive: $ => seq(ci_kw('SHIFT'), optional($.expression)),

    // ─── Conditional (flat boundary markers) ──────────────────

    if_directive: $ => seq(ci_kw('IF'), $.expression),
    elif_directive: $ => seq(ci_kw('ELIF'), $.expression),
    else_directive: _ => ci_kw('ELSE'),
    endc_directive: _ => ci_kw('ENDC'),

    // ─── Loops (flat boundary markers) ────────────────────────

    rept_directive: $ => seq(ci_kw('REPT'), $.expression),

    for_directive: $ => seq(
      ci_kw('FOR'),
      field('variable', $.identifier),
      ',',
      $.expression,
      ',',
      $.expression,
      optional(seq(',', $.expression)),
    ),

    endr_directive: _ => ci_kw('ENDR'),
    break_directive: _ => ci_kw('BREAK'),

    // ─── LOAD / ENDL (Fix #8) ─────────────────────────────────

    load_directive: $ => seq(
      ci_kw('LOAD'),
      optional(choice(ci_kw('UNION'), ci_kw('FRAGMENT'))),
      $.string,
      ',',
      $.section_type,
      optional(seq('[', $.expression, ']')),
      repeat(seq(',', $.section_option)),
    ),

    endl_directive: _ => ci_kw('ENDL'),

    // ─── Charmap ──────────────────────────────────────────────

    charmap_directive: $ => seq(ci_kw('CHARMAP'), $.string, ',', $.expression_list),

    newcharmap_directive: $ => seq(
      ci_kw('NEWCHARMAP'),
      $.identifier,
      optional(seq(',', $.identifier)),
    ),

    setcharmap_directive: $ => seq(ci_kw('SETCHARMAP'), $.identifier),

    pushc_directive: _ => ci_kw('PUSHC'),
    popc_directive: _ => ci_kw('POPC'),

    // ─── Assertions / Output ──────────────────────────────────

    assert_directive: $ => seq(
      choice(ci_kw('ASSERT'), ci_kw('STATIC_ASSERT')),
      $.expression,
      optional(seq(',', $.string)),
    ),

    print_directive: $ => seq(
      choice(ci_kw('PRINT'), ci_kw('PRINTLN')),
      optional($.expression_list),
    ),

    warn_directive: $ => seq(ci_kw('WARN'), $.string),
    fail_directive: $ => seq(ci_kw('FAIL'), $.string),

    // ─── Options / Stacks ─────────────────────────────────────

    opt_directive: $ => seq(ci_kw('OPT'), /[^\r\n;]+/),

    pusho_directive: _ => ci_kw('PUSHO'),
    popo_directive: _ => ci_kw('POPO'),
    pushs_directive: _ => ci_kw('PUSHS'),
    pops_directive: _ => ci_kw('POPS'),

    // ─── Union (as standalone block markers too) ──────────────

    union_directive: _ => ci_kw('UNION'),
    nextu_directive: _ => ci_kw('NEXTU'),
    endu_directive: _ => ci_kw('ENDU'),

    // ─── Expressions ──────────────────────────────────────────

    expression_list: $ => seq(
      $.expression,
      repeat(seq(',', $.expression)),
    ),

    expression: $ => choice(
      $.binary_expression,
      $.unary_expression,
      $.parenthesized_expression,
      $.function_call,
      $.number,
      $.string,
      $.char_literal,
      $.gfx_literal,    // Fix #10: backtick graphics literal
      $.symbol_reference,
      $.macro_arg,
    ),

    binary_expression: $ => {
      /** @type {[string, number][]} */
      const ops = [
        ['||', 1],
        ['&&', 2],
        ['==', 3], ['!=', 3], ['<', 3], ['>', 3], ['<=', 3], ['>=', 3],
        ['+', 4], ['-', 4],
        ['|', 5],
        ['^', 6],
        ['&', 7],
        ['<<', 8], ['>>', 8], ['>>>', 8],
        ['*', 9], ['/', 9], ['%', 9],
        ['**', 10],
      ];
      return choice(
        ...ops.map(([op, p]) =>
          prec.left(p, seq(field('left', $.expression), op, field('right', $.expression)))
        ),
      );
    },

    unary_expression: $ => prec(11, choice(
      seq('-', $.expression),
      seq('+', $.expression),
      seq('~', $.expression),
      seq('!', $.expression),
    )),

    parenthesized_expression: $ => seq('(', $.expression, ')'),

    function_call: $ => seq(
      field('function', $.builtin_function),
      '(',
      optional($.expression_list),
      ')',
    ),

    builtin_function: _ => token(choice(
      ...[
        'HIGH', 'LOW', 'BANK', 'SIZEOF', 'STARTOF', 'DEF', 'ISCONST',
        'STRLEN', 'STRCAT', 'STRCMP', 'STRIN', 'STRSUB', 'STRUPR', 'STRLWR',
        'STRFMT', 'STRRPL', 'STRFIND', 'STRRFIND', 'STRSLICE', 'BYTELEN',
        'STRBYTE', 'INCHARMAP', 'CHARLEN', 'CHARCMP', 'CHARSIZE', 'CHARVAL',
        'BITWIDTH', 'TZCOUNT',
        'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'ATAN2',
        'MUL', 'DIV', 'FMOD', 'POW', 'LOG', 'ROUND', 'CEIL', 'FLOOR',
      ].map(f => ci(f))
    )),

    symbol_reference: $ => choice(
      $.identifier,
      $.scoped_identifier,   // Fix #6: Global.local as reference
      $.local_identifier,
      '@',                   // current PC address
      /:[+-]+/,              // anonymous label refs
    ),

    // ─── Tokens ───────────────────────────────────────────────

    // Fix #5: RGBDS identifiers can start with [a-zA-Z_] and contain # @ in body
    // Note: $ is NOT valid in identifiers — it's the hex prefix
    // Note: @ alone is the PC address symbol, not an identifier
    identifier: _ => /[a-zA-Z_][a-zA-Z0-9_#@]*/,

    // Fix #6: scoped identifier with exactly one dot (Global.local)
    scoped_identifier: _ => /[a-zA-Z_][a-zA-Z0-9_#@]*\.[a-zA-Z_][a-zA-Z0-9_#@]*/,

    local_identifier: _ => /\.[a-zA-Z_][a-zA-Z0-9_]*/,

    // Fix #10: number literals including fixed-point
    number: _ => choice(
      /\$[0-9a-fA-F]+/,            // hex: $FF
      /0[xX][0-9a-fA-F]+/,         // hex: 0xFF
      /%[01]+/,                     // binary: %1010
      /0[bB][01]+/,                 // binary: 0b1010
      /&[0-7]+/,                    // octal: &77
      /0[oO][0-7]+/,               // octal: 0o77
      /[0-9]+\.[0-9]+[qQ][0-9]+/,  // fixed-point with precision: 12.34q8
      /[0-9]+\.[0-9]+/,            // fixed-point: 12.34
      /[0-9]+/,                     // decimal
    ),

    char_literal: _ => seq("'", /[^'\r\n]/, "'"),

    // Fix #10: backtick graphics literal
    gfx_literal: _ => /`[0-3]+/,

    string: _ => seq('"', repeat(choice(/[^"\\\r\n]/, /\\./)), '"'),
  },
});

/**
 * Case-insensitive regex for a keyword.
 * @param {string} keyword
 * @returns {RegExp}
 */
function ci(keyword) {
  return new RegExp(
    keyword.split('').map(c =>
      /[a-zA-Z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c
    ).join('')
  );
}

/**
 * Case-insensitive keyword token (higher precedence to beat identifier).
 * @param {string} keyword
 * @returns {RuleOrLiteral}
 */
function ci_kw(keyword) {
  return token(prec(1, ci(keyword)));
}
