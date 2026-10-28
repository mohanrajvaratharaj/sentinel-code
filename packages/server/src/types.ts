import {
  Diagnostic,
  DiagnosticSeverity,
  CodeAction,
  CodeActionKind,
  TextEdit,
  Range as LspRange,
  WorkspaceEdit
} from 'vscode-languageserver';

// Re-export DiagnosticSeverity so other modules can import it from here
export { DiagnosticSeverity } from 'vscode-languageserver';

/**
 * Represents a single review issue found by either Fast-Gate or Gemini analysis.
 */
export interface ReviewIssue {
  /** Unique identifier for the issue type (e.g. "hardcoded-secret", "sql-injection") */
  code: string;
  /** Human-readable message describing the issue */
  message: string;
  /** Severity level of the issue */
  severity: DiagnosticSeverity;
  /** The file path where the issue was found */
  file: string;
  /** Optional line number (1-based) where the issue occurs */
  line?: number;
  /** Optional character offset (0-based) where the issue starts */
  character?: number;
  /** Optional end line for the issue range */
  endLine?: number;
  /** Optional end character for the issue range */
  endCharacter?: number;
  /** Optional suggested fix that can be applied via QuickFix */
  suggestedFix?: SuggestedFix;
  /** Source of the issue detection */
  source: 'fast-gate' | 'gemini';
  /** Optional category for grouping related issues */
  category?: string;
}

/**
 * Represents a suggested code fix for a review issue.
 */
export interface SuggestedFix {
  /** Description of the fix shown in the IDE */
  title: string;
  /** The text edits to apply */
  edits: TextEdit[];
}

/**
 * Result of running Fast-Gate static analysis on a file.
 */
export interface FastGateResult {
  /** List of issues found by Fast-Gate rules */
  issues: ReviewIssue[];
  /** Whether the file passed all Fast-Gate checks */
  passed: boolean;
  /** Time taken to run Fast-Gate checks in milliseconds */
  durationMs: number;
}

/**
 * Result of running Gemini AI review on a diff.
 */
export interface GeminiReviewResult {
  /** List of issues found by Gemini review */
  issues: ReviewIssue[];
  /** Overall review summary from Gemini */
  summary?: string;
  /** Whether the review passed overall */
  passed: boolean;
  /** Time taken to run Gemini review in milliseconds */
  durationMs: number;
  /** Raw Gemini response for debugging */
  rawResponse?: unknown;
}

/**
 * Combined result from both Fast-Gate and Gemini analysis.
 */
export interface AnalysisResult {
  /** Fast-Gate analysis results */
  fastGate?: FastGateResult;
  /** Gemini review results */
  gemini?: GeminiReviewResult;
  /** All issues combined from both stages */
  allIssues: ReviewIssue[];
  /** Whether all checks passed */
  allPassed: boolean;
  /** Total analysis time in milliseconds */
  totalDurationMs: number;
}

/**
 * Represents a git diff for a single file.
 */
export interface FileDiff {
  /** File path relative to repository root */
  filePath: string;
  /** The unified diff content */
  diff: string;
  /** Whether the file is new (added) */
  isNew: boolean;
  /** Whether the file is deleted */
  isDeleted: boolean;
  /** Whether the file is renamed */
  isRenamed: boolean;
  /** Original file path if renamed */
  originalPath?: string;
}

/**
 * Configuration for PII scrubbing before sending diffs to external APIs.
 */
export interface PIIScrubberConfig {
  /** Whether to enable PII scrubbing (default: true) */
  enabled?: boolean;
  /** Categories to exclude from scrubbing */
  excludedCategories?: string[];
  /** Whether to redact file paths containing usernames (default: true) */
  redactFilePaths?: boolean;
}

/**
 * Configuration for smart diff chunking.
 */
export interface DiffChunkerConfig {
  /** Maximum characters per chunk (default: ~4000, roughly 1000 tokens) */
  maxChunkSize?: number;
  /** Whether to strip whitespace-only changes (default: true) */
  stripWhitespace?: boolean;
  /** Whether to detect and prioritize function bodies (default: true) */
  detectFunctions?: boolean;
}

/**
 * Configuration for automated test generation.
 */
export interface TestGeneratorConfig {
  /** Default test framework to use (overrides auto-detection) */
  framework?: 'jest' | 'pytest';
  /** Whether to include async test wrappers (default: true) */
  includeAsyncWrappers?: boolean;
  /** Whether to include edge case tests (default: true) */
  includeEdgeCases?: boolean;
}

/**
 * Configuration for the Sentinel code review tool.
 */
export interface SentinelConfig {
  /** Path to the workspace root */
  workspaceRoot: string;
  /** Whether to enable Gemini AI review */
  enableGeminiReview: boolean;
  /** Gemini model to use */
  geminiModel?: string;
  /** Whether to enable Fast-Gate checks */
  enableFastGate: boolean;
  /** Custom rules file path */
  rulesFile?: string;
  /** File extensions to monitor */
  monitoredExtensions: string[];
  /** Whether to auto-analyze on save */
  autoAnalyzeOnSave: boolean;
  /** Maximum diff size in bytes before skipping Gemini review */
  maxDiffSizeBytes: number;
  /** PII scrubbing configuration */
  piiScrubber?: PIIScrubberConfig;
  /** Smart diff chunking configuration */
  diffChunker?: DiffChunkerConfig;
  /** Test generation configuration */
  testGenerator?: TestGeneratorConfig;
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: SentinelConfig = {
  workspaceRoot: '',
  enableGeminiReview: true,
  geminiModel: 'gemini-3.8-flash',
  enableFastGate: true,
  rulesFile: '.github/review-rules.md',
  monitoredExtensions: ['.ts', '.js', '.tsx', '.jsx', '.py', '.go'],
  autoAnalyzeOnSave: true,
  maxDiffSizeBytes: 1024 * 1024, // 1MB
  piiScrubber: {
    enabled: true,
    redactFilePaths: true
  },
  diffChunker: {
    maxChunkSize: 4000,
    stripWhitespace: true,
    detectFunctions: true
  },
  testGenerator: {
    includeAsyncWrappers: true,
    includeEdgeCases: true
  }
};

/**
 * Fast-Gate rule definition for static analysis.
 */
export interface FastGateRule {
  /** Unique identifier for the rule */
  id: string;
  /** Human-readable name of the rule */
  name: string;
  /** Description of what the rule checks for */
  description: string;
  /** Regular expression pattern to match */
  pattern: RegExp;
  /** Severity of issues found by this rule */
  severity: DiagnosticSeverity;
  /** Category for grouping */
  category: string;
  /** Optional message template with {match} placeholder */
  messageTemplate?: string;
  /** Optional fix template */
  fixTemplate?: string;
}

/**
 * Built-in Fast-Gate rules for common code issues.
 */
export const BUILTIN_FAST_GATE_RULES: FastGateRule[] = [
  {
    id: 'hardcoded-secret',
    name: 'Hardcoded Secret Detection',
    description: 'Detects potential hardcoded secrets, API keys, or tokens',
    pattern: /\b(api[_-]?key|secret|password|token|auth[_-]?token|access[_-]?token)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    severity: DiagnosticSeverity.Error,
    category: 'security',
    messageTemplate: 'Potential hardcoded secret detected. Use environment variables or a secrets manager instead.'
  },
  {
    id: 'console-log',
    name: 'Console Log Detection',
    description: 'Detects console.log statements that should be removed before PR',
    pattern: /console\.(log|debug|info)\s*\(/g,
    severity: DiagnosticSeverity.Warning,
    category: 'best-practice',
    messageTemplate: 'Console statement found. Consider using a proper logging framework or removing before PR.'
  },
  {
    id: 'todo-comment',
    name: 'TODO Comment Detection',
    description: 'Detects TODO, FIXME, or HACK comments that should be addressed',
    pattern: /\/\/\s*(TODO|FIXME|HACK|XXX|BUG)\b/gi,
    severity: DiagnosticSeverity.Warning,
    category: 'code-quality',
    messageTemplate: 'Unresolved comment found. Please address before creating PR.'
  },
  {
    id: 'raw-sql-query',
    name: 'Raw SQL Query Detection',
    description: 'Detects potential SQL injection vulnerabilities from string concatenation',
    pattern: /(execute|query|raw)\s*\(\s*['"`].*(?:\+|\$\{).*['"`]/gi,
    severity: DiagnosticSeverity.Error,
    category: 'security',
    messageTemplate: 'Potential SQL injection vulnerability. Use parameterized queries instead of string concatenation.'
  },
  {
    id: 'eval-usage',
    name: 'Eval Usage Detection',
    description: 'Detects use of eval() which is a security risk',
    pattern: /\beval\s*\(/g,
    severity: DiagnosticSeverity.Error,
    category: 'security',
    messageTemplate: 'Use of eval() detected. This is a security risk. Consider safer alternatives.'
  },
  {
    id: 'any-type',
    name: 'Any Type Usage',
    description: 'Detects usage of any type in TypeScript which bypasses type checking',
    pattern: /:\s*any\b/g,
    severity: DiagnosticSeverity.Warning,
    category: 'type-safety',
    messageTemplate: 'Usage of "any" type detected. Consider using a more specific type for better type safety.'
  },
  {
    id: 'unused-import',
    name: 'Potentially Unused Import',
    description: 'Detects imports that may not be used in the file',
    pattern: /import\s+.*from\s+['"].*['"]\s*$/gm,
    severity: DiagnosticSeverity.Warning,
    category: 'code-quality',
    messageTemplate: 'Check if this import is actually used in the file.'
  },
  {
    id: 'mutate-state',
    name: 'Direct State Mutation',
    description: 'Detects direct mutation of state objects which may cause issues',
    pattern: /\.state\s*\.\s*\w+\s*=/g,
    severity: DiagnosticSeverity.Warning,
    category: 'best-practice',
    messageTemplate: 'Direct state mutation detected. Consider using immutable update patterns.'
  }
];

/**
 * Converts a ReviewIssue to an LSP Diagnostic.
 */
export function toLspDiagnostic(issue: ReviewIssue): Diagnostic {
  const range: LspRange = {
    start: {
      line: (issue.line ?? 1) - 1,
      character: issue.character ?? 0
    },
    end: {
      line: (issue.endLine ?? issue.line ?? 1) - 1,
      character: issue.endCharacter ?? 0
    }
  };

  return {
    range,
    severity: issue.severity,
    source: `sentinel-code/${issue.source}`,
    code: issue.code,
    message: issue.message,
    codeDescription: {
      href: `https://github.com/sentinel-code/sentinel-code/issues?q=${issue.code}`
    }
  };
}

/**
 * Converts a ReviewIssue with a suggested fix to an LSP CodeAction.
 */
export function toLspCodeAction(issue: ReviewIssue, uri: string): CodeAction | null {
  if (!issue.suggestedFix) {
    return null;
  }

  const edit: WorkspaceEdit = {
    changes: {
      [uri]: issue.suggestedFix.edits
    }
  };

  return {
    title: issue.suggestedFix.title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [toLspDiagnostic(issue)],
    isPreferred: true,
    edit
  };
}
