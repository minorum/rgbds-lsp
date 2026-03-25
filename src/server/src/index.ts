#!/usr/bin/env node

// Catch startup crashes and write to stderr before exiting
process.on('uncaughtException', (err) => {
    process.stderr.write(`[rgbds-lsp] Fatal: ${err.message}\n${err.stack}\n`);
    process.exit(1);
});

// Exit cleanly when the parent process (VS Code/editor) disconnects the IPC channel.
// Without this, orphaned server processes keep native addon .node files locked on Windows.
process.on('disconnect', () => process.exit(0));

import './server';
