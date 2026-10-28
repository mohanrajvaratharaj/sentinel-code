/**
 * Smart Diff Chunking Module
 *
 * Parses unified git diffs to:
 * 1. Extract modified function/method bodies (prioritized for review)
 * 2. Strip whitespace-only noise
 * 3. Chunk large diffs into manageable pieces fitting token budgets
 * 4. Preserve hunk context for accurate line number mapping
 */

import { FileDiff } from './types';

/**
 * A single changed region extracted from a unified diff hunk.
 */
export interface DiffHunk {
  /** Start line in the old file (1-based) */
  oldStart: number;
  /** Number of lines from the old file */
  oldLines: number;
  /** Start line in the new file (1-based) */
  newStart: number;
  /** Number of lines in the new file */
  newLines: number;
  /** The raw hunk content (with +/- prefixes) */
  content: string;
  /** Number of added lines */
  addedLines: number;
  /** Number of removed lines */
  removedLines: number;
  /** Whether this hunk appears to be inside a function/method body */
  isInFunction: boolean;
  /** The name of the surrounding function, if detected */
  functionName?: string;
}

/**
 * A chunk of diff content ready for sending to an LLM.
 */
export interface DiffChunk {
  /** The file path */
  filePath: string;
  /** Chunk index (0-based) */
  chunkIndex: number;
  /** Total number of chunks for this file */
  totalChunks: number;
  /** The diff content for this chunk */
  diffContent: string;
  /** Approximate character count */
  charCount: number;
  /** Whether this chunk contains function-level changes (higher priority) */
  isHighPriority: boolean;
  /** Function names contained in this chunk */
  functionNames: string[];
}

/**
 * Configuration for diff chunking behavior.
 */
export interface DiffChunkerConfig {
  /** Maximum characters per chunk (default: ~4000, roughly 1000 tokens) */
  maxChunkSize?: number;
  /** Whether to strip whitespace-only changes (default: true) */
  stripWhitespace?: boolean;
  /** Whether to detect and prioritize function bodies (default: true) */
  detectFunctions?: boolean;
  /** Context lines to keep around changes (default: 3) */
  contextLines?: number;
}

export const DEFAULT_CHUNKER_CONFIG: DiffChunkerConfig = {
  maxChunkSize: 4000,
  stripWhitespace: true,
  detectFunctions: true,
  contextLines: 3
};

/**
 * Patterns that indicate the start of a function/method definition.
 * Covers TypeScript, JavaScript, Python, and Go.
 */
const FUNCTION_START_PATTERNS = [
  // TypeScript/JavaScript: function name(, async function name(, const name = (
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?/,
  // Class methods: name(, async name(
  /^\s+(?:static\s+)?(?:async\s+)?(\w+)\s*\(/,
  // Arrow functions: const name = () =>
  /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
  // Python: def name(
  /^\s*def\s+(\w+)\s*\(/,
  // Go: func Name(, func (r *Receiver) Name(
  /^\s*func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(/,
];

/**
 * Patterns that indicate whitespace-only lines (noise).
 */
const WHITESPACE_NOISE_PATTERN = /^\s+$/;

/**
 * Parse a unified diff string into structured hunks.
 *
 * @param diff - The unified diff output from `git diff`
 * @returns Array of parsed hunks
 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diff.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Match hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldLines = parseInt(hunkMatch[2] || '1', 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const newLines = parseInt(hunkMatch[4] || '1', 10);

      i++;
      const hunkLines: string[] = [];
      let addedLines = 0;
      let removedLines = 0;

      // Collect hunk body lines
      while (i < lines.length) {
        const hunkLine = lines[i];

        // Stop at the next hunk header or file header
        if (hunkLine.startsWith('@@') || hunkLine.startsWith('---') || hunkLine.startsWith('+++')) {
          break;
        }

        if (hunkLine.startsWith('+')) {
          addedLines++;
        } else if (hunkLine.startsWith('-')) {
          removedLines++;
        }

        hunkLines.push(hunkLine);
        i++;
      }

      // Detect if this hunk is inside a function body
      const { isInFunction, functionName } = detectFunctionContext(hunkLines, lines, i - hunkLines.length);

      hunks.push({
        oldStart,
        oldLines,
        newStart,
        newLines,
        content: hunkLines.join('\n'),
        addedLines,
        removedLines,
        isInFunction,
        functionName
      });
    } else {
      i++;
    }
  }

  return hunks;
}

/**
 * Detect whether a hunk is inside a function body and extract the function name.
 * Looks at context lines and surrounding diff for function definitions.
 */
function detectFunctionContext(
  hunkLines: string[],
  allLines: string[],
  hunkStartIndex: number
): { isInFunction: boolean; functionName?: string } {
  // Combine context lines from the hunk
  const contextText = hunkLines
    .filter(line => line.startsWith(' ') || line.startsWith('+'))
    .map(line => line.substring(1))
    .join('\n');

  // Also look at a few lines before the hunk in the original file for function headers
  const beforeLines: string[] = [];
  for (let j = Math.max(0, hunkStartIndex - 10); j < hunkStartIndex; j++) {
    beforeLines.push(allLines[j]);
  }
  const beforeText = beforeLines.join('\n');

  const searchText = beforeText + '\n' + contextText;

  for (const pattern of FUNCTION_START_PATTERNS) {
    const match = searchText.match(pattern);
    if (match && match[1]) {
      // Filter out common non-function keywords
      const keyword = match[1];
      if (!['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw', 'else'].includes(keyword)) {
        return { isInFunction: true, functionName: keyword };
      }
    }
  }

  return { isInFunction: false };
}

/**
 * Strip whitespace-only changes from diff hunks.
 * Lines that only add/remove whitespace are considered noise.
 */
export function stripWhitespaceNoise(hunks: DiffHunk[]): DiffHunk[] {
  return hunks.map(hunk => {
    const lines = hunk.content.split('\n');
    const filteredLines = lines.filter(line => {
      if (line.startsWith('+') || line.startsWith('-')) {
        const content = line.substring(1);
        // Keep the line if it has non-whitespace content
        return !WHITESPACE_NOISE_PATTERN.test(content);
      }
      // Always keep context lines
      return true;
    });

    // Recount added/removed lines
    let addedLines = 0;
    let removedLines = 0;
    for (const line of filteredLines) {
      if (line.startsWith('+')) addedLines++;
      else if (line.startsWith('-')) removedLines++;
    }

    return {
      ...hunk,
      content: filteredLines.join('\n'),
      addedLines,
      removedLines
    };
  });
}

/**
 * Chunk a file's diff into manageable pieces for LLM token budgets.
 *
 * @param fileDiff - The file diff to chunk
 * @param config - Chunking configuration
 * @returns Array of diff chunks
 */
export function chunkDiff(fileDiff: FileDiff, config: DiffChunkerConfig = DEFAULT_CHUNKER_CONFIG): DiffChunk[] {
  const maxChunkSize = config.maxChunkSize || DEFAULT_CHUNKER_CONFIG.maxChunkSize!;

  // Step 1: Parse hunks
  let hunks = parseDiffHunks(fileDiff.diff);

  if (hunks.length === 0) {
    return [];
  }

  // Step 2: Optionally strip whitespace noise
  if (config.stripWhitespace) {
    hunks = stripWhitespaceNoise(hunks);
  }

  // Step 3: Sort hunks — function hunks first (higher priority)
  const sortedHunks = [...hunks].sort((a, b) => {
    if (a.isInFunction && !b.isInFunction) return -1;
    if (!a.isInFunction && b.isInFunction) return 1;
    return a.newStart - b.newStart;
  });

  // Step 4: Group hunks into chunks respecting maxChunkSize
  const chunks: DiffChunk[] = [];
  let currentChunkHunks: DiffHunk[] = [];
  let currentChunkSize = 0;
  let currentIsHighPriority = false;
  const currentFunctionNames: Set<string> = new Set();

  for (const hunk of sortedHunks) {
    const hunkSize = hunk.content.length;

    // If adding this hunk exceeds the limit and we already have hunks, flush
    if (currentChunkSize + hunkSize > maxChunkSize && currentChunkHunks.length > 0) {
      chunks.push(createChunk(
        fileDiff.filePath,
        chunks.length,
        currentChunkHunks,
        currentChunkSize,
        currentIsHighPriority,
        currentFunctionNames
      ));

      currentChunkHunks = [];
      currentChunkSize = 0;
      currentIsHighPriority = false;
      currentFunctionNames.clear();
    }

    currentChunkHunks.push(hunk);
    currentChunkSize += hunkSize;
    if (hunk.isInFunction) currentIsHighPriority = true;
    if (hunk.functionName) currentFunctionNames.add(hunk.functionName);
  }

  // Flush remaining hunks
  if (currentChunkHunks.length > 0) {
    chunks.push(createChunk(
      fileDiff.filePath,
      chunks.length,
      currentChunkHunks,
      currentChunkSize,
      currentIsHighPriority,
      currentFunctionNames
    ));
  }

  // Update totalChunks count
  for (const chunk of chunks) {
    chunk.totalChunks = chunks.length;
  }

  return chunks;
}

/**
 * Create a DiffChunk from a group of hunks.
 */
function createChunk(
  filePath: string,
  chunkIndex: number,
  hunks: DiffHunk[],
  charCount: number,
  isHighPriority: boolean,
  functionNames: Set<string>
): DiffChunk {
  // Build the chunk's diff content with file header
  let diffContent = `--- a/${filePath}\n+++ b/${filePath}\n`;

  for (const hunk of hunks) {
    diffContent += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
    diffContent += hunk.content + '\n';
  }

  return {
    filePath,
    chunkIndex,
    totalChunks: 1, // Will be updated after all chunks are created
    diffContent,
    charCount,
    isHighPriority,
    functionNames: Array.from(functionNames)
  };
}

/**
 * Get a summary of the diff structure for logging or status reporting.
 */
export function getDiffSummary(fileDiff: FileDiff): {
  totalHunks: number;
  functionHunks: number;
  totalAdded: number;
  totalRemoved: number;
  functionNames: string[];
} {
  const hunks = parseDiffHunks(fileDiff.diff);
  const functionNames = new Set<string>();

  let totalAdded = 0;
  let totalRemoved = 0;
  let functionHunks = 0;

  for (const hunk of hunks) {
    totalAdded += hunk.addedLines;
    totalRemoved += hunk.removedLines;
    if (hunk.isInFunction) {
      functionHunks++;
      if (hunk.functionName) functionNames.add(hunk.functionName);
    }
  }

  return {
    totalHunks: hunks.length,
    functionHunks,
    totalAdded,
    totalRemoved,
    functionNames: Array.from(functionNames)
  };
}

/**
 * Build a compact diff representation optimized for LLM prompts.
 * This strips context lines and keeps only the actual changes,
 * reducing token usage while preserving review-relevant information.
 */
export function buildCompactDiff(fileDiff: FileDiff): string {
  const hunks = parseDiffHunks(fileDiff.diff);
  if (hunks.length === 0) return '';

  let compact = `## File: ${fileDiff.filePath}\n`;
  compact += `## Status: ${fileDiff.isNew ? 'New file' : fileDiff.isDeleted ? 'Deleted' : 'Modified'}\n\n`;

  for (const hunk of hunks) {
    if (hunk.functionName) {
      compact += `### Function: ${hunk.functionName}\n`;
    }

    // Only include changed lines, not context
    const changedLines = hunk.content.split('\n').filter(line =>
      line.startsWith('+') || line.startsWith('-')
    );

    if (changedLines.length > 0) {
      compact += `\`\`\`diff\n${changedLines.join('\n')}\n\`\`\`\n\n`;
    }
  }

  return compact;
}
