import { FoldingRange, FoldingRangeKind } from 'vscode-languageserver/node';
import Parser from 'tree-sitter';

interface BlockEntry {
    type: string;
    startLine: number;
}

/**
 * Get the directive type from a line node by traversing:
 * line → statement → directive → specific_directive_type
 */
function getDirectiveType(lineNode: Parser.SyntaxNode): string | null {
    for (const child of lineNode.namedChildren) {
        if (child.type === 'statement') {
            for (const stmtChild of child.namedChildren) {
                if (stmtChild.type === 'directive') {
                    const firstChild = stmtChild.firstChild;
                    if (firstChild) {
                        return firstChild.type;
                    }
                }
            }
        }
    }
    return null;
}

/**
 * Check if a line node is a comment-only line:
 * exactly one named child and it is a comment.
 */
function isCommentOnlyLine(lineNode: Parser.SyntaxNode): boolean {
    return lineNode.namedChildren.length === 1 && lineNode.namedChildren[0].type === 'comment';
}

/**
 * Extract folding ranges from a parsed tree-sitter tree for RGBDS assembly.
 */
export function getFoldingRanges(tree: Parser.Tree): FoldingRange[] {
    const ranges: FoldingRange[] = [];
    const stack: BlockEntry[] = [];
    let lastSectionLine: number | null = null;

    // Comment block tracking
    let commentStart: number | null = null;
    let commentEnd: number | null = null;

    const lines = tree.rootNode.children;

    function flushCommentBlock(): void {
        if (commentStart !== null && commentEnd !== null && commentEnd - commentStart >= 2) {
            ranges.push(FoldingRange.create(commentStart, commentEnd, undefined, undefined, FoldingRangeKind.Comment));
        }
        commentStart = null;
        commentEnd = null;
    }

    function emitBlockRange(startLine: number, closerLine: number): void {
        const endLine = closerLine - 1;
        if (endLine > startLine) {
            ranges.push(FoldingRange.create(startLine, endLine));
        }
    }

    /**
     * Pop the stack looking for one of the expected opener types.
     * Returns the popped entry or null.
     */
    function popMatching(...types: string[]): BlockEntry | null {
        if (stack.length === 0) return null;
        const top = stack[stack.length - 1];
        if (types.includes(top.type)) {
            return stack.pop()!;
        }
        return null;
    }

    for (const lineNode of lines) {
        if (lineNode.type !== 'line' && lineNode.type !== 'final_line') {
            continue;
        }

        const lineNum = lineNode.startPosition.row;
        const directive = getDirectiveType(lineNode);

        // Handle comment block tracking
        if (isCommentOnlyLine(lineNode)) {
            if (commentStart === null) {
                commentStart = lineNum;
            }
            commentEnd = lineNum;

            // Still process directives below only if there's no directive
            if (!directive) continue;
        }

        // If we reach here with a non-comment line (or a line with a directive), flush any comment block
        if (!isCommentOnlyLine(lineNode)) {
            flushCommentBlock();
        }

        if (!directive) continue;

        switch (directive) {
            case 'section_directive': {
                // Close previous section if any
                if (lastSectionLine !== null) {
                    emitBlockRange(lastSectionLine, lineNum);
                }
                lastSectionLine = lineNum;
                break;
            }

            case 'macro_start': {
                stack.push({ type: 'macro_start', startLine: lineNum });
                break;
            }

            case 'endm_directive': {
                const entry = popMatching('macro_start');
                if (entry) {
                    emitBlockRange(entry.startLine, lineNum);
                }
                break;
            }

            case 'if_directive': {
                stack.push({ type: 'if_directive', startLine: lineNum });
                break;
            }

            case 'elif_directive': {
                // Close previous IF/ELIF sub-region
                const entry = popMatching('if_directive', 'elif_directive');
                if (entry) {
                    emitBlockRange(entry.startLine, lineNum);
                }
                // Open new sub-region for ELIF
                stack.push({ type: 'elif_directive', startLine: lineNum });
                break;
            }

            case 'else_directive': {
                // Close previous IF/ELIF sub-region
                const entry = popMatching('if_directive', 'elif_directive');
                if (entry) {
                    emitBlockRange(entry.startLine, lineNum);
                }
                // Open new sub-region for ELSE
                stack.push({ type: 'else_directive', startLine: lineNum });
                break;
            }

            case 'endc_directive': {
                const entry = popMatching('if_directive', 'elif_directive', 'else_directive');
                if (entry) {
                    emitBlockRange(entry.startLine, lineNum);
                }
                break;
            }

            case 'rept_directive':
            case 'for_directive': {
                stack.push({ type: directive, startLine: lineNum });
                break;
            }

            case 'endr_directive': {
                const entry = popMatching('rept_directive', 'for_directive');
                if (entry) {
                    emitBlockRange(entry.startLine, lineNum);
                }
                break;
            }

            case 'union_directive': {
                stack.push({ type: 'union_directive', startLine: lineNum });
                break;
            }

            case 'nextu_directive': {
                // Close previous UNION/NEXTU sub-region
                const entry = popMatching('union_directive', 'nextu_directive');
                if (entry) {
                    emitBlockRange(entry.startLine, lineNum);
                }
                stack.push({ type: 'nextu_directive', startLine: lineNum });
                break;
            }

            case 'endu_directive': {
                const entry = popMatching('union_directive', 'nextu_directive');
                if (entry) {
                    emitBlockRange(entry.startLine, lineNum);
                }
                break;
            }

            case 'load_directive': {
                stack.push({ type: 'load_directive', startLine: lineNum });
                break;
            }

            case 'endl_directive': {
                const entry = popMatching('load_directive');
                if (entry) {
                    emitBlockRange(entry.startLine, lineNum);
                }
                break;
            }
        }
    }

    // Flush trailing comment block
    flushCommentBlock();

    // Close last section if it was open (extends to last line of file)
    if (lastSectionLine !== null) {
        const lastLine = tree.rootNode.endPosition.row;
        if (lastLine > lastSectionLine) {
            ranges.push(FoldingRange.create(lastSectionLine, lastLine));
        }
    }

    return ranges;
}
