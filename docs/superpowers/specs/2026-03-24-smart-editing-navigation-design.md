# Smart Editing & Navigation — v0.3.0 Design Spec

## Context

RGBDS-LSP v0.2.0 shipped with rich hover, instruction completions, doc-comment extraction, workspace symbols, document links, and indexer caching. The next milestone focuses on making the editor understand RGBDS assembly more deeply: semantic highlighting, code folding, improved INCLUDE navigation, and code actions.

Build & debug integration is explicitly out of scope for this release.

## Feature 1: Semantic Tokens

### Goal

Provide LSP-driven token classification so the editor highlights registers, mnemonics, constants, macros, and other constructs more accurately than the TextMate grammar alone.

### Token Mapping

All tokens map to standard semantic token types — no custom types. This ensures any color theme works without customization.

| AST Node | Semantic Type | Modifier | Notes |
|----------|--------------|----------|-------|
| `mnemonic` | `keyword` | | ld, jp, call, etc. |
| `register`, `sp_register` | `variable` | `readonly` | a, b, hl, sp |
| `condition` | `enumMember` | | z, nz, c, nc |
| `identifier` (label def) | `function` | `declaration` | Resolved via indexer |
| `identifier` (label ref) | `function` | | Resolved via indexer |
| `identifier` (constant def/ref) | `variable` | `readonly` | EQU/EQUS/SET symbols |
| `identifier` (macro def/ref) | `function` | | MACRO symbols |
| `local_identifier` | `function` | | .localLabel |
| `number` | `number` | | $FF, %1010, 42 |
| `string` | `string` | | "text" |
| `comment` | `comment` | | ; line comments |
| directive keywords | `keyword` | | SECTION, DB, IF, etc. |
| `macro_arg` | `parameter` | | \1, \2, \@ |

### Implementation

- Add `semanticTokensProvider` capability to `onInitialize` with the legend (types + modifiers).
- Handler: `textDocument/semanticTokens/full`. Walk the tree-sitter AST for the document, classify each named node, and emit the encoded token array (line, col, length, type, modifiers).
- For identifiers, look up the name in the indexer's `definitions` map to determine if it's a label, constant, or macro. Unresolved identifiers get no semantic token (fall back to TextMate).
- Support `textDocument/semanticTokens/full/delta` later if performance requires it. Start with full only.

### Files

- `packages/server/src/semantic-tokens.ts` — NEW: token extraction logic, legend definition
- `packages/server/src/server.ts` — register capability, add handler

## Feature 2: Folding Ranges

### Goal

Allow collapsing structured blocks in the editor: sections, macros, conditionals, loops, unions, and comment blocks.

### Foldable Regions

| Start | End | Kind |
|-------|-----|------|
| `SECTION` | next `SECTION` or EOF | region |
| `MACRO` / label `: MACRO` | `ENDM` | region |
| `IF` | `ENDC` | region |
| `ELIF` | next `ELIF` / `ELSE` / `ENDC` | region |
| `ELSE` | `ENDC` | region |
| `REPT` / `FOR` | `ENDR` | region |
| `UNION` | `NEXTU` / `ENDU` | region |
| `NEXTU` | next `NEXTU` / `ENDU` | region |
| `LOAD` | `ENDL` | region |
| 3+ consecutive `;` comment lines | last comment line | comment |

### Implementation

- Add `foldingRangeProvider: true` to capabilities.
- Handler: `textDocument/foldingRange`. Walk the AST's top-level `line` nodes. For each line, check `namedChildren` for `statement` → `directive` → `firstChild.type` to identify block openers/closers (same traversal pattern as `getDirectiveKeyword` in server.ts). Use a stack to track open blocks (push on MACRO/IF/REPT/etc., pop on ENDM/ENDC/ENDR/etc.). Emit `FoldingRange` for each matched pair.
- For SECTION folding, track the start line and close at the next SECTION or EOF.
- For comment blocks, accumulate consecutive comment-only lines and emit when the streak breaks (minimum 3 lines).

### Files

- `packages/server/src/folding.ts` — NEW: folding range extraction
- `packages/server/src/server.ts` — register capability, add handler

## Feature 3: INCLUDE Navigation

### Goal

Two improvements to navigating include files:

1. **Go-to-definition on INCLUDE paths** — F12 on `INCLUDE "file.inc"` opens the file (currently only Ctrl+click via document links works).
2. **Find all includers** — show all files that INCLUDE the current file.

### Implementation

#### 3a: INCLUDE Go-to-Definition

In the `onDefinition` handler, before the symbol lookup, check if the cursor is inside a `string` child of an `include_directive` node. If so, resolve the path, verify the file exists on disk with `fs.existsSync`, and return a Location pointing to line 0 of the target file.

#### 3b: Include Graph

The indexer already walks all files. During `extractSymbols`, also record include relationships: for each `include_directive`, store `{ from: uri, to: resolvedUri, line, col }` in a new `IncludeRef` record.

**Data structure**: `includers: Map<string, IncludeRef[]>` keyed by the **included** file's URI. Each entry lists all locations where that file is included from. This supports the primary query ("who includes this file?") as a direct map lookup.

**`IncludeRef` interface**: `{ from: string; line: number; col: number; endCol: number }` — the `from` field is the URI of the file containing the INCLUDE directive.

**Lifecycle**:
- `reindexFile` must clear all `includers` entries whose `from` field matches the file being re-indexed before re-extracting, consistent with how definitions and references are cleaned.
- `CacheEntry` must include an `includes` field: `[string, IncludeRef[]][]`. Bump `CACHE_VERSION` to invalidate existing caches.
- `loadCache` / `saveCache` must serialize and restore `includers` entries per file.

Expose via `onReferences`: when the cursor is on an `include_directive` string, return all locations where this file is included from by looking up `includers.get(resolvedTargetUri)`.

### Files

- `packages/server/src/indexer.ts` — add `includers: Map<string, IncludeRef[]>`, extract during `extractSymbols`, clean in `reindexFile`, serialize in cache
- `packages/server/src/types.ts` — add `IncludeRef` interface
- `packages/server/src/server.ts` — extend `onDefinition` and `onReferences` handlers

## Feature 4: Code Actions

### Goal

Lightbulb quick-fix suggestions. Start with one high-value action, add more incrementally.

### Phase 1: Convert Number Base

When the cursor is on a number literal, offer code actions to convert between representations:

- `$FF` → offer "Convert to decimal (255)" and "Convert to binary (%11111111)"
- `255` → offer "Convert to hex ($FF)" and "Convert to binary (%11111111)"
- `%11111111` → offer "Convert to hex ($FF)" and "Convert to decimal (255)"

Implementation: register `codeActionProvider`. In the handler, use `getNodeAtPosition` to find `number` nodes. Parse the value, generate TextEdits for each alternative representation.

### Phase 2 (future): Extract to Constant

Select a number literal, code action offers to extract it as a named EQU constant. Inserts the constant definition above the current section and replaces the literal with the name. After applying the edit, triggers a rename operation on the placeholder name so the user can type the desired name.

### Phase 3 (future): Add EXPORT

On an "Undefined symbol" diagnostic where the symbol exists in another file's definitions but isn't exported, offer to add `EXPORT symbolName` in the defining file.

### Files

- `packages/server/src/code-actions.ts` — NEW: code action logic
- `packages/server/src/server.ts` — register capability, add handler

## Implementation Order

1. **Folding ranges** — simplest, self-contained, immediate UX improvement
2. **Semantic tokens** — highest visual impact, needs indexer lookups
3. **INCLUDE navigation** — extends existing handlers, needs indexer addition
4. **Code actions (number convert)** — new capability, reuses existing number parsing

Each feature is independently shippable.

## Verification

After each feature:
1. `cd packages/server && npm run build` — compiles clean
2. `cd packages/server && npm test` — all tests pass
3. Rebuild and reinstall extension, reload VS Code
4. Manual verification:
   - Folding: open a file with MACRO/ENDM, verify fold icons appear
   - Semantic tokens: verify registers/mnemonics get different colors than in TextMate-only mode
   - INCLUDE navigation: F12 on an INCLUDE string opens the file
   - Code actions: cursor on `$FF`, lightbulb offers decimal/binary conversion
