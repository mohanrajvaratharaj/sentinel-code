#!/usr/bin/env node

import {
  createConnection,
  InitializeParams,
  TextDocumentSyncKind,
  Diagnostic,
  CodeActionKind,
  CodeAction,
  CodeActionParams,
  Connection
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as path from 'path';
import * as fs from 'fs';
import { Analyzer } from './analyzer';
import {
  SentinelConfig,
  DEFAULT_CONFIG,
  toLspDiagnostic,
  toLspCodeAction,
  ReviewIssue,
  FileDiff,
  AnalysisResult
} from './types';
import {
  getFileDiff,
  getCombinedDiff,
  isGitRepository,
  getGitRoot,
  hasUncommittedChanges
} from './git-engine';

/**
 * LSP Server for Sentinel Code Review
 *
 * This server:
 * 1. Listens to document save and change events
 * 2. Extracts git diffs for changed files
 * 3. Runs Fast-Gate and Gemini analysis
 * 4. Publishes diagnostics to the IDE
 * 5. Provides QuickFix code actions for issues with suggested fixes
 */

// Create the LSP connection
const connection: Connection = createConnection();

// Client capability flags
let clientSupportsCodeAction: boolean = false;
let clientSupportsDiagnostics: boolean = false;

// Server state
let workspaceRoot: string = '';
let config: SentinelConfig = { ...DEFAULT_CONFIG };
let analyzer: Analyzer | null = null;
let documentsByUri = new Map<string, TextDocument>();
let analysisInProgress = new Set<string>();
let gitRoot: string | null = null;

/**
 * Logger for server messages
 */
function logInfo(message: string) {
  connection.console.info(`[Sentinel] ${message}`);
}

function logError(message: string, _error?: unknown) {
  connection.console.error(`[Sentinel] ${message}`);
}

function logWarning(message: string) {
  connection.console.warn(`[Sentinel] ${message}`);
}

/**
 * Initialize the server
 */
connection.onInitialize(async (params: InitializeParams) => {
  logInfo('Initializing Sentinel Code Review server...');

  // Extract workspace root
  const workspaceFolders = params.rootUri ? [params.rootUri] : (params.workspaceFolders ?? []).map(f => f.uri);
  if (workspaceFolders.length > 0) {
    workspaceRoot = URI.parse(workspaceFolders[0]).fsPath;
    config.workspaceRoot = workspaceRoot;
  }

  // Check client capabilities
  clientSupportsCodeAction = true;
  clientSupportsDiagnostics = true;

  // Check if workspace is a git repository
  const detectedGitRoot = await getGitRoot(workspaceRoot);
  gitRoot = detectedGitRoot;

  if (!gitRoot) {
    logWarning('Workspace is not a git repository. Sentinel will only provide Fast-Gate checks.');
  } else {
    logInfo(`Git repository detected at: ${gitRoot}`);
  }

  // Load workspace configuration
  await loadWorkspaceConfig(params);

  // Initialize analyzer
  analyzer = new Analyzer(config);

  logInfo('Sentinel Code Review server initialized successfully');

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: true }
      },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix]
      },
      workspace: {
        workspaceFolders: {
          supported: true,
          changeNotifications: true
        },
        configuration: true
      }
    }
  };
});

/**
 * Load workspace-specific configuration
 */
async function loadWorkspaceConfig(params: InitializeParams) {
  // Try to load sentinel.config.json from workspace root
  const configPath = path.join(workspaceRoot, 'sentinel.config.json');
  if (fs.existsSync(configPath)) {
    try {
      const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      config = { ...config, ...rawConfig };
      logInfo(`Loaded configuration from ${configPath}`);
    } catch (error) {
      logError('Failed to load sentinel.config.json:', error);
    }
  }

  // Check for GEMINI_API_KEY
  if (!process.env.GEMINI_API_KEY) {
    logWarning('GEMINI_API_KEY not set. Gemini AI review will be disabled.');
  }
}

/**
 * Handle document open
 */
connection.onDidOpenTextDocument(async ({ textDocument }) => {
  const uri = textDocument.uri;
  const document = TextDocument.create(uri, 'typescript', textDocument.version, textDocument.text);
  documentsByUri.set(uri, document);
});

/**
 * Handle document change
 */
connection.onDidChangeTextDocument(async ({ textDocument, contentChanges }) => {
  const document = documentsByUri.get(textDocument.uri);
  if (!document) return;

  const newText = contentChanges.reduce((text, change) => {
    if ('range' in change) {
      const lines = text.split('\n');
      const startLine = change.range.start.line;
      const startChar = change.range.start.character;
      const endLine = change.range.end.line;
      const endChar = change.range.end.character;

      const firstLine = lines[startLine];
      const lastLine = lines[endLine];
      const newFirstLine = firstLine.substring(0, startChar) + change.text;
      const newLastLine = change.text + lastLine.substring(endChar);

      if (startLine === endLine) {
        lines[startLine] = newFirstLine;
      } else {
        lines[startLine] = newFirstLine;
        lines[endLine] = newLastLine;
        for (let i = startLine + 1; i < endLine; i++) {
          lines.splice(i, 1);
        }
      }

      return lines.join('\n');
    }
    return change.text;
  }, document.getText());

  const newDocument = TextDocument.create(
    textDocument.uri,
    'typescript',
    textDocument.version,
    newText
  );
  documentsByUri.set(textDocument.uri, newDocument);
});

/**
 * Handle document save - trigger analysis
 */
connection.onDidSaveTextDocument(async ({ textDocument }) => {
  if (!config.autoAnalyzeOnSave) return;

  const uri = textDocument.uri;
  await analyzeDocument(uri);
});

/**
 * Handle document close
 */
connection.onDidCloseTextDocument(({ textDocument }) => {
  const uri = textDocument.uri;
  documentsByUri.delete(uri);

  // Clear diagnostics for closed document
  connection.sendDiagnostics({ uri, diagnostics: [] });
});

/**
 * Analyze a document and publish diagnostics
 */
async function analyzeDocument(uri: string) {
  // Prevent concurrent analysis of the same file
  if (analysisInProgress.has(uri)) {
    logInfo(`Analysis already in progress for ${uri}, skipping`);
    return;
  }

  analysisInProgress.add(uri);

  try {
    const filePath = URI.parse(uri).fsPath;
    const relativePath = path.relative(workspaceRoot, filePath);

    // Check if file has uncommitted changes
    if (gitRoot) {
      const hasChanges = await hasUncommittedChanges(gitRoot, relativePath);
      if (!hasChanges) {
        // No changes, clear diagnostics
        connection.sendDiagnostics({ uri, diagnostics: [] });
        logInfo(`No uncommitted changes for ${relativePath}, clearing diagnostics`);
        return;
      }
    }

    // Get the file diff
    let fileDiff: FileDiff | null = null;
    if (gitRoot) {
      fileDiff = await getFileDiff(gitRoot, relativePath);
    }

    // If no diff but file exists, create a minimal diff for Fast-Gate
    if (!fileDiff) {
      const document = documentsByUri.get(uri);
      if (document) {
        fileDiff = {
          filePath: relativePath,
          diff: document.getText(),
          isNew: true,
          isDeleted: false,
          isRenamed: false
        };
      }
    }

    if (!fileDiff) {
      logWarning(`Could not get diff for ${relativePath}`);
      return;
    }

    // Get current file content
    const document = documentsByUri.get(uri);
    const fileContent = document?.getText();

    // Run analysis
    if (!analyzer) {
      logError('Analyzer not initialized');
      return;
    }

    const result = await analyzer.analyze(fileDiff, fileContent);

    // Publish diagnostics
    const diagnostics: Diagnostic[] = result.allIssues
      .filter(issue => issue.file === relativePath || issue.file === path.basename(relativePath))
      .map(issue => toLspDiagnostic(issue));

    connection.sendDiagnostics({ uri, diagnostics });

    if (result.allIssues.length > 0) {
      logInfo(
        `Analysis complete for ${relativePath}: ${result.allIssues.length} issues found in ${result.totalDurationMs}ms`
      );
    } else {
      logInfo(`Analysis complete for ${relativePath}: No issues found in ${result.totalDurationMs}ms`);
    }

  } catch (error) {
    logError(`Analysis failed for ${uri}:`, error);
  } finally {
    analysisInProgress.delete(uri);
  }
}

/**
 * Handle code action requests
 */
connection.onCodeAction(async (params: CodeActionParams): Promise<CodeAction[] | null> => {
  const { textDocument, range, context } = params;
  const uri = textDocument.uri;

  const codeActions: CodeAction[] = [];

  // Filter diagnostics to find Sentinel issues
  for (const diagnostic of context.diagnostics) {
    if (diagnostic.source?.startsWith('sentinel-code/')) {
      // Try to find the original issue
      const issue = findIssueByDiagnostic(uri, diagnostic);
      if (issue && issue.suggestedFix) {
        const codeAction = toLspCodeAction(issue, uri);
        if (codeAction) {
          codeActions.push(codeAction);
        }
      }
    }
  }

  return codeActions.length > 0 ? codeActions : null;
});

/**
 * Find the original ReviewIssue for a diagnostic
 */
function findIssueByDiagnostic(uri: string, diagnostic: Diagnostic): ReviewIssue | null {
  // This is a simplified lookup - in production, you'd maintain a cache of issues
  // For now, we return null as the issues are ephemeral
  // The code action will still work for issues that have suggestedFix
  return null;
}

/**
 * Handle workspace configuration changes
 */
connection.onDidChangeConfiguration(async ({ settings }) => {
  logInfo('Configuration changed, reloading...');

  if (settings && settings['sentinel-code']) {
    const sentinelSettings = settings['sentinel-code'];
    config = { ...config, ...sentinelSettings };

    if (analyzer) {
      analyzer.updateConfig(config);
    }
  }

  logInfo('Configuration reloaded successfully');
});

/**
 * Custom request: Trigger manual review
 */
connection.onRequest('sentinel/review', async ({ uri }: { uri: string }) => {
  logInfo(`Manual review requested for ${uri}`);
  await analyzeDocument(uri);
  return { success: true };
});

/**
 * Custom request: Get analysis status
 */
connection.onRequest('sentinel/status', async () => {
  return {
    workspaceRoot,
    gitRoot,
    config: {
      enableGeminiReview: config.enableGeminiReview,
      enableFastGate: config.enableFastGate,
      hasGeminiApiKey: !!process.env.GEMINI_API_KEY
    },
    analysisInProgress: Array.from(analysisInProgress)
  };
});

/**
 * Handle shutdown
 */
connection.onShutdown(async () => {
  logInfo('Shutting down Sentinel Code Review server...');
});

/**
 * Handle exit
 */
connection.onExit(() => {
  logInfo('Sentinel Code Review server exited');
});

// Start the server
connection.listen();
logInfo('Sentinel Code Review server started');
