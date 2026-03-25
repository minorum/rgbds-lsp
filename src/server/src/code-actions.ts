import {
    CodeAction,
    CodeActionParams,
    CodeActionKind,
    TextEdit,
    WorkspaceEdit,
    Range,
} from 'vscode-languageserver/node';
import Parser from 'tree-sitter';
import { getNodeAtPosition, parseNumberLiteral } from './utils';

export function getCodeActions(
    params: CodeActionParams,
    tree: Parser.Tree | undefined,
): CodeAction[] {
    const actions: CodeAction[] = [];
    const { range, textDocument, context } = params;

    // Quick fix: replace mismatched comment bytes with computed bytes
    for (const diag of context.diagnostics) {
        if (diag.source !== 'rgbds') continue;
        const match = diag.message.match(/^Byte mismatch: comment has .+, expected (.+)$/);
        if (!match) continue;

        const expectedBytes = match[1]; // e.g. "$74 $69 $6D $80 $8E"
        // Replace just the byte portion of the comment (the diagnostic range covers it)
        const commentBytes = expectedBytes.replace(/\$/g, '').replace(/ /g, ' ');

        actions.push({
            title: `Fix comment bytes: ${commentBytes}`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diag],
            isPreferred: true,
            edit: {
                changes: {
                    [textDocument.uri]: [
                        TextEdit.replace(diag.range, '; ' + commentBytes),
                    ],
                },
            },
        });
    }

    // Number base conversions
    if (tree) {
        const node = getNodeAtPosition(tree, range.start.line, range.start.character);
        if (node && node.type === 'number') {
            const nodeStart = node.startPosition;
            const nodeEnd = node.endPosition;
            const intersects = !(
                nodeEnd.row < range.start.line ||
                (nodeEnd.row === range.start.line && nodeEnd.column <= range.start.character) ||
                nodeStart.row > range.end.line ||
                (nodeStart.row === range.end.line && nodeStart.column >= range.end.character)
            );

            if (intersects) {
                const text = node.text;
                const parsed = parseNumberLiteral(text);
                if (parsed && !parsed.isFixedPoint) {
                    const cleaned = text.replace(/_/g, '');
                    let currentBase: 'hex' | 'binary' | 'octal' | 'decimal';
                    if (cleaned.startsWith('$') || cleaned.toLowerCase().startsWith('0x')) {
                        currentBase = 'hex';
                    } else if (cleaned.startsWith('%') || cleaned.toLowerCase().startsWith('0b')) {
                        currentBase = 'binary';
                    } else if (cleaned.startsWith('&') || cleaned.toLowerCase().startsWith('0o')) {
                        currentBase = 'octal';
                    } else {
                        currentBase = 'decimal';
                    }

                    const nodeRange: Range = {
                        start: { line: nodeStart.row, character: nodeStart.column },
                        end: { line: nodeEnd.row, character: nodeEnd.column },
                    };

                    const conversions = [
                        { base: 'hex', label: `Convert to hex (${parsed.hex})`, replacement: parsed.hex },
                        { base: 'decimal', label: `Convert to decimal (${parsed.decimal})`, replacement: parsed.decimal },
                        { base: 'binary', label: `Convert to binary (${parsed.binary})`, replacement: parsed.binary },
                        { base: 'octal', label: `Convert to octal (${parsed.octal})`, replacement: parsed.octal },
                    ];

                    for (const conv of conversions) {
                        if (conv.base === currentBase) continue;
                        actions.push({
                            title: conv.label,
                            kind: CodeActionKind.RefactorRewrite,
                            edit: {
                                changes: {
                                    [textDocument.uri]: [TextEdit.replace(nodeRange, conv.replacement)],
                                },
                            },
                        });
                    }
                }
            }
        }
    }

    return actions;
}
