# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RGBDS-LSP is a Language Server Protocol implementation for RGBDS (Rednex Game Boy Development System) assembly. It provides IDE features for `.asm` and `.inc` files targeting the GBZ80/SM83 CPU. Monorepo with three packages: a Tree-sitter grammar, an LSP server, and a VS Code extension.

## Build Commands

```bash
# Install dependencies and build everything (grammar must generate before native build)
npm install && npm run build

# Clean all build artifacts
npm run clean

# Grammar tests (tree-sitter corpus tests)
cd packages/tree-sitter-rgbds && npx tree-sitter test

# Server tests (vitest)
cd packages/server && npm test

# Regenerate parser from grammar.js (required after grammar changes)
cd packages/tree-sitter-rgbds && npx tree-sitter generate
```

**Critical build order**: `tree-sitter generate` must run before `npm install` because the native addon build (node-gyp) depends on the generated `src/parser.c`. The root build script handles this, but be aware when working manually.

## Architecture

```
VS Code Extension  ──►  LSP Server  ──►  Tree-sitter Parser
(packages/vscode)    (packages/server)  (packages/tree-sitter-rgbds)
```

### tree-sitter-rgbds (`packages/tree-sitter-rgbds/`)
- `grammar.js` defines the complete RGBDS assembly grammar (case-insensitive keywords, local label scoping, macro parameters)
- Generates `src/parser.c` (C parser) compiled to a native Node.js addon
- Test corpus in `test/corpus/*.txt` — add tests here when modifying grammar rules

### server (`packages/server/src/`)
- `server.ts` — LSP connection setup and all protocol handlers (definition, references, hover, completion, rename, diagnostics, document symbols)
- `indexer.ts` — Core engine: parses files with tree-sitter, walks ASTs to extract symbol definitions and references. Maintains two maps: `definitions` and `references`. Handles local label scoping by prefixing `.local` names with their parent global label
- `types.ts` — Shared interfaces (`SymbolDefinition`, `SymbolReference`)
- `utils.ts` — File path utilities

### vscode (`packages/vscode/`)
- Thin client that launches the server via stdio
- TextMate grammar in `syntaxes/rgbds.tmLanguage.json` for syntax highlighting

## Key Design Details

- **Local label scoping**: Labels starting with `.` are stored as `GlobalLabel.local` in the index. The indexer tracks `currentGlobal` state while scanning each file to resolve scope.
- **Symbol types**: `label`, `constant` (EQU/EQUS/SET), `macro`, `section`
- **Incremental indexing**: On file change, only the changed file is re-indexed (`indexFile`). Full project scan happens at startup (`indexProject`).
- **Diagnostics**: Warns on undefined symbol references. Max 200 per file.
