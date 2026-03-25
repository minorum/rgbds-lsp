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
    if (!tree) return [];

    const { range, textDocument } = params;

    // Find the node at the start of the selection/cursor
    const node = getNodeAtPosition(tree, range.start.line, range.start.character);
    if (!node || node.type !== 'number') return [];

    // Ensure the number node intersects the requested range
    const nodeStart = node.startPosition;
    const nodeEnd = node.endPosition;
    if (
        nodeEnd.row < range.start.line ||
        (nodeEnd.row === range.start.line && nodeEnd.column <= range.start.character) ||
        nodeStart.row > range.end.line ||
        (nodeStart.row === range.end.line && nodeStart.column >= range.end.character)
    ) {
        return [];
    }

    const text = node.text;
    const parsed = parseNumberLiteral(text);
    if (!parsed || parsed.isFixedPoint) return [];

    // Determine current base from source text
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

    const actions: CodeAction[] = [];

    const conversions: Array<{ base: string; label: string; replacement: string }> = [
        { base: 'hex', label: `Convert to hex (${parsed.hex})`, replacement: parsed.hex },
        { base: 'decimal', label: `Convert to decimal (${parsed.decimal})`, replacement: parsed.decimal },
        { base: 'binary', label: `Convert to binary (${parsed.binary})`, replacement: parsed.binary },
        { base: 'octal', label: `Convert to octal (${parsed.octal})`, replacement: parsed.octal },
    ];

    for (const conv of conversions) {
        if (conv.base === currentBase) continue;

        const edit: WorkspaceEdit = {
            changes: {
                [textDocument.uri]: [
                    TextEdit.replace(nodeRange, conv.replacement),
                ],
            },
        };

        actions.push({
            title: conv.label,
            kind: CodeActionKind.RefactorRewrite,
            edit,
        });
    }

    return actions;
}
