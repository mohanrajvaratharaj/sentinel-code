import * as path from 'path';
import * as fs from 'fs';
import { workspace, ExtensionContext, OutputChannel, window, commands, WorkspaceFolder } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;
let outputChannel: OutputChannel;

/**
 * Activates the Sentinel Code Review extension.
 * This is the entry point for the VS Code extension.
 */
export async function activate(context: ExtensionContext) {
  outputChannel = window.createOutputChannel('Sentinel Code Review', { log: true });
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('Sentinel Code Review extension activated');

  // Get the server module path
  const serverModule = getServerModulePath(context);
  if (!serverModule) {
    outputChannel.appendLine('ERROR: Could not find server module. Make sure to run `npm run build:server` first.');
    window.showWarningMessage('Sentinel Code Review: Server not found. Please build the server first.');
    return;
  }

  // Check if server file exists
  if (!fs.existsSync(serverModule)) {
    outputChannel.appendLine(`ERROR: Server module not found at ${serverModule}`);
    window.showWarningMessage('Sentinel Code Review: Server file not found. Please run `npm run build:server`.');
    return;
  }

  // Initialize the language client
  await startLanguageClient(context, serverModule);

  // Register commands
  context.subscriptions.push(
    commands.registerCommand('sentinelCode.triggerReview', async () => {
      await triggerManualReview();
    }),
    commands.registerCommand('sentinelCode.showOutput', () => {
      outputChannel.show();
    })
  );

  outputChannel.appendLine('Sentinel Code Review extension ready');
}

/**
 * Resolves the path to the LSP server module.
 */
function getServerModulePath(context: ExtensionContext): string | null {
  // Try to find the server module in the monorepo structure
  const possiblePaths = [
    // Development: server is in sibling package
    path.join(context.extensionPath, '..', 'server', 'dist', 'server.js'),
    // Production: server is bundled with extension
    path.join(context.extensionPath, 'server', 'dist', 'server.js'),
    // Alternative: server is in the same directory
    path.join(context.extensionPath, 'dist', 'server.js')
  ];

  for (const serverPath of possiblePaths) {
    if (fs.existsSync(serverPath)) {
      outputChannel.appendLine(`Found server module at: ${serverPath}`);
      return serverPath;
    }
  }

  outputChannel.appendLine('Could not find server module in any of the expected locations');
  return null;
}

/**
 * Starts the LSP language client.
 */
async function startLanguageClient(context: ExtensionContext, serverModule: string) {
  // Options for the server
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ['--nolazy', '--inspect=6009']
      }
    }
  };

  // Document selectors for supported languages
  const documentSelector = [
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'typescriptreact' },
    { scheme: 'file', language: 'javascript' },
    { scheme: 'file', language: 'javascriptreact' },
    { scheme: 'file', language: 'python' },
    { scheme: 'file', language: 'go' }
  ];

  // Options for the language client
  const clientOptions: LanguageClientOptions = {
    documentSelector,
    outputChannel,
    diagnosticCollectionName: 'sentinel-code',
    synchronize: {
      // Synchronize configuration section to server
      configurationSection: 'sentinel-code'
    },
    initializationOptions: {
      // Pass workspace configuration to server
      ...getWorkspaceConfiguration()
    }
  };

  // Create the language client
  client = new LanguageClient(
    'sentinelCode',
    'Sentinel Code Review',
    serverOptions,
    clientOptions
  );

  // Start the client
  try {
    await client.start();
    outputChannel.appendLine('Language client started successfully');
  } catch (error) {
    outputChannel.appendLine(`ERROR: Failed to start language client: ${error}`);
    window.showErrorMessage('Sentinel Code Review: Failed to start language server.');
  }

  // Register the client for disposal
  context.subscriptions.push(client);
}

/**
 * Gets the current workspace configuration.
 */
function getWorkspaceConfiguration() {
  const config = workspace.getConfiguration('sentinel-code');
  return {
    enableGeminiReview: config.get<boolean>('enableGeminiReview', true),
    enableFastGate: config.get<boolean>('enableFastGate', true),
    autoAnalyzeOnSave: config.get<boolean>('autoAnalyzeOnSave', true),
    geminiModel: config.get<string>('geminiModel', 'gemini-2.5-flash'),
    maxDiffSizeBytes: config.get<number>('maxDiffSizeBytes', 1024 * 1024)
  };
}

/**
 * Triggers a manual code review for the active document.
 */
async function triggerManualReview() {
  const editor = window.activeTextEditor;
  if (!editor) {
    window.showInformationMessage('No active editor to review.');
    return;
  }

  const document = editor.document;
  outputChannel.appendLine(`Manual review triggered for: ${document.uri.fsPath}`);

  // Send custom request to server
  if (client) {
    try {
      const result = await client.sendRequest('sentinel/review', {
        uri: document.uri.toString()
      });
      outputChannel.appendLine(`Manual review result: ${JSON.stringify(result)}`);
      window.showInformationMessage('Code review completed. Check the Problems panel for issues.');
    } catch (error) {
      outputChannel.appendLine(`Manual review failed: ${error}`);
      window.showErrorMessage('Code review failed. Check the output for details.');
    }
  }
}

/**
 * Deactivates the extension and stops the language client.
 */
export async function deactivate() {
  outputChannel.appendLine('Sentinel Code Review extension deactivating');

  if (client) {
    await client.stop();
    outputChannel.appendLine('Language client stopped');
  }
}
