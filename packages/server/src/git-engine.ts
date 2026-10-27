import { spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { FileDiff } from './types';

const exec = promisify(spawn);

/**
 * Represents the result of a git command execution.
 */
interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Executes a git command in the specified directory.
 */
async function gitExec(cwd: string, args: string[]): Promise<GitExecResult> {
  try {
    const result: any = await exec('git', args, {
      cwd,
      timeout: 10000 // 10 second timeout
    });

    return {
      stdout: (result.stdout as string).trim(),
      stderr: (result.stderr as string).trim(),
      exitCode: result.status
    };
  } catch (error: any) {
    return {
      stdout: '',
      stderr: error.message || 'Unknown error',
      exitCode: error.status ?? 1
    };
  }
}

/**
 * Checks if the given directory is a git repository.
 */
export async function isGitRepository(workspaceRoot: string): Promise<boolean> {
  const result = await gitExec(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
  return result.exitCode === 0 && result.stdout === 'true';
}

/**
 * Gets the git repository root directory.
 */
export async function getGitRoot(workspaceRoot: string): Promise<string | null> {
  const result = await gitExec(workspaceRoot, ['rev-parse', '--show-toplevel']);
  if (result.exitCode === 0) {
    return result.stdout;
  }
  return null;
}

/**
 * Extracts uncommitted diffs relative to HEAD for a specific file.
 * This is the core function used by the analyzer to get the diff content.
 *
 * @param workspaceRoot - The root directory of the workspace
 * @param filePath - The file path relative to the workspace root
 * @returns FileDiff object or null if the file has no changes
 */
export async function getFileDiff(workspaceRoot: string, filePath: string): Promise<FileDiff | null> {
  const fullPath = path.join(workspaceRoot, filePath);

  // Check if file exists
  if (!fs.existsSync(fullPath)) {
    // File might be deleted - check git status
    const statusResult = await gitExec(workspaceRoot, ['status', '--porcelain', filePath]);
    if (statusResult.exitCode === 0 && statusResult.stdout.startsWith('D ')) {
      return {
        filePath,
        diff: '',
        isNew: false,
        isDeleted: true,
        isRenamed: false
      };
    }
    return null;
  }

  // Get the diff against HEAD
  const diffResult = await gitExec(workspaceRoot, ['diff', 'HEAD', '--', filePath]);
  if (diffResult.exitCode !== 0) {
    // If HEAD doesn't exist (initial commit), try diff --cached for staged changes
    const cachedResult = await gitExec(workspaceRoot, ['diff', '--cached', '--', filePath]);
    if (cachedResult.exitCode === 0 && cachedResult.stdout.length > 0) {
      return parseDiffResult(filePath, cachedResult.stdout, false, false);
    }
    return null;
  }

  if (diffResult.stdout.length === 0) {
    return null;
  }

  return parseDiffResult(filePath, diffResult.stdout, false, false);
}

/**
 * Extracts all uncommitted diffs for files matching the specified extensions.
 *
 * @param workspaceRoot - The root directory of the workspace
 * @param extensions - Array of file extensions to filter (e.g., ['.ts', '.js'])
 * @returns Array of FileDiff objects for all changed files
 */
export async function getAllFileDiffs(
  workspaceRoot: string,
  extensions: string[]
): Promise<FileDiff[]> {
  // Get list of changed files
  const statusResult = await gitExec(workspaceRoot, ['status', '--porcelain']);
  if (statusResult.exitCode !== 0 || statusResult.stdout.length === 0) {
    return [];
  }

  const diffs: FileDiff[] = [];
  const lines = statusResult.stdout.split('\n').filter(line => line.trim().length > 0);

  for (const line of lines) {
    // Parse porcelain output: "XY path" where X is staging area, Y is working tree
    const match = line.match(/^(\S{2})\s+(.+)$/);
    if (!match) continue;

    const status = match[1];
    let filePath = match[2];

    // Handle renamed files: "XY path -> new_path"
    const renameMatch = filePath.match(/^(.+)\s+->\s+(.+)$/);
    if (renameMatch) {
      filePath = renameMatch[2];
    }

    // Filter by extensions
    const ext = path.extname(filePath).toLowerCase();
    if (!extensions.includes(ext)) {
      continue;
    }

    const diff = await getFileDiff(workspaceRoot, filePath);
    if (diff) {
      diffs.push(diff);
    }
  }

  return diffs;
}

/**
 * Gets the diff for a specific file, including both staged and unstaged changes.
 *
 * @param workspaceRoot - The root directory of the workspace
 * @param filePath - The file path relative to the workspace root
 * @returns Combined diff string or empty string if no changes
 */
export async function getCombinedDiff(workspaceRoot: string, filePath: string): Promise<string> {
  // Get unstaged diff
  const unstagedResult = await gitExec(workspaceRoot, ['diff', '--', filePath]);
  const unstagedDiff = unstagedResult.exitCode === 0 ? unstagedResult.stdout : '';

  // Get staged diff
  const stagedResult = await gitExec(workspaceRoot, ['diff', '--cached', '--', filePath]);
  const stagedDiff = stagedResult.exitCode === 0 ? stagedResult.stdout : '';

  // Combine diffs
  const diffs = [unstagedDiff, stagedDiff].filter(d => d.length > 0);
  return diffs.join('\n');
}

/**
 * Parses the git diff output to determine file status.
 */
function parseDiffResult(
  filePath: string,
  diff: string,
  forceNew: boolean,
  forceDeleted: boolean
): FileDiff {
  const isNew = forceNew || diff.includes('+++ b/') && diff.includes('\\ No newline') && !diff.includes('--- a/');
  const isDeleted = forceDeleted || diff.includes('--- a/') && !diff.includes('+++ b/');
  const isRenamed = diff.includes('similarity index') && diff.includes('rename');

  return {
    filePath,
    diff,
    isNew,
    isDeleted,
    isRenamed,
    originalPath: isRenamed ? extractOriginalPath(diff) : undefined
  };
}

/**
 * Extracts the original file path from a rename diff.
 */
function extractOriginalPath(diff: string): string | undefined {
  const match = diff.match(/--- a\/(.+)/);
  return match ? match[1] : undefined;
}

/**
 * Gets the list of staged files ready for commit.
 */
export async function getStagedFiles(workspaceRoot: string): Promise<string[]> {
  const result = await gitExec(workspaceRoot, ['diff', '--cached', '--name-only']);
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout.split('\n').filter(line => line.trim().length > 0);
}

/**
 * Gets the list of unstaged modified files.
 */
export async function getUnstagedFiles(workspaceRoot: string): Promise<string[]> {
  const result = await gitExec(workspaceRoot, ['diff', '--name-only']);
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout.split('\n').filter(line => line.trim().length > 0);
}

/**
 * Checks if a file has uncommitted changes.
 */
export async function hasUncommittedChanges(workspaceRoot: string, filePath: string): Promise<boolean> {
  const diff = await getCombinedDiff(workspaceRoot, filePath);
  return diff.length > 0;
}

/**
 * Gets the current branch name.
 */
export async function getCurrentBranch(workspaceRoot: string): Promise<string | null> {
  const result = await gitExec(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.exitCode === 0) {
    return result.stdout;
  }
  return null;
}

/**
 * Gets the commit hash of HEAD.
 */
export async function getHeadCommit(workspaceRoot: string): Promise<string | null> {
  const result = await gitExec(workspaceRoot, ['rev-parse', 'HEAD']);
  if (result.exitCode === 0) {
    return result.stdout;
  }
  return null;
}
