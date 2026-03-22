# RGBDS Language Server — Claude Code Plugin

Language intelligence for RGBDS Game Boy assembly in Claude Code.

## Features

- Go to definition
- Find all references
- Symbol completion
- Hover documentation
- Diagnostics (undefined symbols)
- Cross-file rename
- Document outline

## Installation

### 1. Install the language server

```bash
npm install -g rgbds-language-server
```

### 2. Add the plugin to Claude Code

```bash
claude --plugin-dir /path/to/rgbds-lsp/packages/claude-plugin
```

Or add to your project's `.claude/settings.json`:

```json
{
  "lspServers": {
    "rgbds": {
      "command": "rgbds-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".asm": "asm",
        ".inc": "asm"
      }
    }
  }
}
```

### 3. Verify

Run `/plugins` in Claude Code to check the plugin loaded. Open any `.asm` or `.inc` file — the language server will index your project automatically.
