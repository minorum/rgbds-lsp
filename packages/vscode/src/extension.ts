import { workspace, ExtensionContext, window } from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';
import { execSync } from 'child_process';
import * as path from 'path';

let client: LanguageClient;

function findServer(): string | null {
    // 1. Check extension setting
    const configPath = workspace.getConfiguration('rgbds').get<string>('serverPath');
    if (configPath) return configPath;

    // 2. Try to resolve from globally installed package
    try {
        return execSync('node -e "process.stdout.write(require.resolve(\'@minorum/rgbds-language-server\'))"', {
            encoding: 'utf-8',
            timeout: 5000,
        }).trim();
    } catch {}

    return null;
}

export function activate(context: ExtensionContext) {
    const serverModule = findServer();

    if (!serverModule) {
        window.showErrorMessage(
            'RGBDS language server not found. Install it with: npm install -g @minorum/rgbds-language-server',
            'Install now',
        ).then(choice => {
            if (choice === 'Install now') {
                const terminal = window.createTerminal('RGBDS LSP Install');
                terminal.sendText('npm install -g @minorum/rgbds-language-server');
                terminal.show();
            }
        });
        return;
    }

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'rgbds' },
        ],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher('**/*.{asm,inc}'),
        },
    };

    client = new LanguageClient(
        'rgbds-lsp',
        'RGBDS Language Server',
        serverOptions,
        clientOptions,
    );

    client.start();
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) return undefined;
    return client.stop();
}
