import * as fs from 'fs';
import * as path from 'path';
import {
  ReviewIssue,
  FastGateResult,
  GeminiReviewResult,
  AnalysisResult,
  FileDiff,
  SentinelConfig,
  BUILTIN_FAST_GATE_RULES,
  FastGateRule
} from './types';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { GoogleGenAI } from '@google/genai';

/**
 * Gemini review response schema for structured output.
 */
interface GeminiReviewResponse {
  /** Summary of the overall review */
  summary: string;
  /** List of issues found */
  issues: GeminiIssue[];
  /** Overall pass/fail status */
  passed: boolean;
}

interface GeminiIssue {
  /** Unique code identifier for the issue */
  code: string;
  /** Human-readable message */
  message: string;
  /** Severity: "error" or "warning" */
  severity: 'error' | 'warning';
  /** File path where the issue was found */
  file: string;
  /** Line number (1-based) */
  line?: number;
  /** Character offset (0-based) */
  character?: number;
  /** End line */
  endLine?: number;
  /** End character */
  endCharacter?: number;
  /** Category of the issue */
  category?: string;
  /** Optional suggested fix */
  suggestedFix?: {
    /** Title of the fix */
    title: string;
    /** Description of the fix */
    description: string;
    /** Code snippet for the fix */
    codeSnippet?: string;
  };
}

/**
 * Analyzer class that orchestrates the three-stage review pipeline:
 * 1. Fast-Gate: Local regex/AST rules for immediate checks
 * 2. Team Rules: Custom rules from .github/review-rules.md
 * 3. Gemini JSON Review: AI-powered review using Gemini 2.5 Flash
 */
export class Analyzer {
  private config: SentinelConfig;
  private teamRules: string | null;

  constructor(config: SentinelConfig) {
    this.config = config;
    this.teamRules = null;
  }

  /**
   * Updates the configuration and reloads team rules.
   */
  updateConfig(config: SentinelConfig) {
    this.config = config;
    this.teamRules = null; // Force reload
  }

  /**
   * Loads custom team rules from .github/review-rules.md if present.
   */
  private async loadTeamRules(): Promise<string | null> {
    if (this.teamRules !== null) {
      return this.teamRules;
    }

    const rulesPath = path.join(
      this.config.workspaceRoot,
      this.config.rulesFile || '.github/review-rules.md'
    );

    try {
      if (fs.existsSync(rulesPath)) {
        this.teamRules = fs.readFileSync(rulesPath, 'utf-8');
        return this.teamRules;
      }
    } catch (error) {
      console.error(`[Sentinel] Failed to load team rules from ${rulesPath}:`, error);
    }

    this.teamRules = null;
    return null;
  }

  /**
   * Runs the complete analysis pipeline on a file diff.
   *
   * @param fileDiff - The file diff to analyze
   * @param fileContent - The current file content for context
   * @returns AnalysisResult with all issues found
   */
  async analyze(fileDiff: FileDiff, fileContent?: string): Promise<AnalysisResult> {
    const startTime = Date.now();
    const allIssues: ReviewIssue[] = [];

    // Stage 1: Fast-Gate
    let fastGateResult: FastGateResult | undefined;
    if (this.config.enableFastGate) {
      fastGateResult = await this.runFastGate(fileDiff, fileContent);
      allIssues.push(...fastGateResult.issues);
    }

    // Stage 2: Load team rules for context
    const teamRules = await this.loadTeamRules();

    // Stage 3: Gemini JSON Review
    let geminiResult: GeminiReviewResult | undefined;
    if (this.config.enableGeminiReview && this.hasGeminiApiKey()) {
      // Check diff size limit
      const diffSize = Buffer.byteLength(fileDiff.diff, 'utf-8');
      if (diffSize <= this.config.maxDiffSizeBytes) {
        try {
          geminiResult = await this.runGeminiReview(fileDiff, teamRules, fileContent);
          allIssues.push(...geminiResult.issues);
        } catch (error) {
          console.error('[Sentinel] Gemini review failed:', error);
          // Continue with Fast-Gate results only
        }
      } else {
        console.warn(
          `[Sentinel] Skipping Gemini review for ${fileDiff.filePath}: diff size ${diffSize} exceeds limit ${this.config.maxDiffSizeBytes}`
        );
      }
    } else if (this.config.enableGeminiReview && !this.hasGeminiApiKey()) {
      console.warn('[Sentinel] Gemini review enabled but GEMINI_API_KEY not set. Skipping Gemini review.');
    }

    const totalDurationMs = Date.now() - startTime;

    return {
      fastGate: fastGateResult,
      gemini: geminiResult,
      allIssues,
      allPassed: allIssues.length === 0,
      totalDurationMs
    };
  }

  /**
   * Checks if the Gemini API key is configured.
   */
  private hasGeminiApiKey(): boolean {
    return !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 0;
  }

  /**
   * Stage 1: Run Fast-Gate static analysis using built-in rules.
   */
  private async runFastGate(fileDiff: FileDiff, fileContent?: string): Promise<FastGateResult> {
    const startTime = Date.now();
    const issues: ReviewIssue[] = [];

    // Use file content if available, otherwise use diff
    const contentToCheck = fileContent || fileDiff.diff;

    for (const rule of BUILTIN_FAST_GATE_RULES) {
      const matches = this.findMatches(contentToCheck, rule);
      for (const match of matches) {
        const message = rule.messageTemplate
          ? rule.messageTemplate.replace('{match}', match.text)
          : `${rule.name}: ${match.text}`;

        const issue: ReviewIssue = {
          code: rule.id,
          message,
          severity: rule.severity,
          file: fileDiff.filePath,
          line: match.line,
          character: match.character,
          endLine: match.endLine,
          endCharacter: match.endCharacter,
          source: 'fast-gate',
          category: rule.category
        };

        issues.push(issue);
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      issues,
      passed: issues.length === 0,
      durationMs
    };
  }

  /**
   * Finds all matches for a rule in the content.
   */
  private findMatches(content: string, rule: FastGateRule): Array<{
    text: string;
    line: number;
    character: number;
    endLine: number;
    endCharacter: number;
  }> {
    const matches: Array<{
      text: string;
      line: number;
      character: number;
      endLine: number;
      endCharacter: number;
    }> = [];

    // Reset regex state for global matches
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match;

    while ((match = regex.exec(content)) !== null) {
      const text = match[0];
      const beforeMatch = content.substring(0, match.index);
      const lines = beforeMatch.split('\n');
      const line = lines.length;
      const character = lines[lines.length - 1].length;

      // Calculate end position
      const matchedLines = text.split('\n');
      const endLine = line + matchedLines.length - 1;
      const endCharacter = matchedLines.length === 1
        ? character + text.length
        : matchedLines[matchedLines.length - 1].length;

      matches.push({
        text,
        line,
        character,
        endLine,
        endCharacter
      });
    }

    return matches;
  }

  /**
   * Stage 3: Run Gemini AI review with structured JSON output.
   */
  private async runGeminiReview(
    fileDiff: FileDiff,
    teamRules: string | null,
    fileContent?: string
  ): Promise<GeminiReviewResult> {
    const startTime = Date.now();

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const client = new GoogleGenAI({ apiKey });
    const model = this.config.geminiModel || 'gemini-3.8-flash';

    // Build the prompt
    const prompt = this.buildReviewPrompt(fileDiff, teamRules, fileContent);

    // Define the response schema for structured output
    const responseSchema = {
      type: 'OBJECT' as const,
      properties: {
        summary: {
          type: 'STRING' as const,
          description: 'A brief summary of the code review findings'
        },
        issues: {
          type: 'ARRAY' as const,
          description: 'List of issues found during review',
          items: {
            type: 'OBJECT' as const,
            properties: {
              code: {
                type: 'STRING' as const,
                description: 'Unique identifier for the issue type'
              },
              message: {
                type: 'STRING' as const,
                description: 'Human-readable description of the issue'
              },
              severity: {
                type: 'STRING' as const,
                description: 'Severity level: "error" or "warning"',
                enum: ['error', 'warning']
              },
              file: {
                type: 'STRING' as const,
                description: 'File path where the issue was found'
              },
              line: {
                type: 'INTEGER' as const,
                description: 'Line number where the issue occurs (1-based)'
              },
              character: {
                type: 'INTEGER' as const,
                description: 'Character offset where the issue starts (0-based)'
              },
              endLine: {
                type: 'INTEGER' as const,
                description: 'End line of the issue'
              },
              endCharacter: {
                type: 'INTEGER' as const,
                description: 'End character of the issue'
              },
              category: {
                type: 'STRING' as const,
                description: 'Category of the issue (e.g., security, performance, style)'
              },
              suggestedFix: {
                type: 'OBJECT' as const,
                description: 'Optional suggested fix for the issue',
                properties: {
                  title: {
                    type: 'STRING' as const,
                    description: 'Short title for the fix'
                  },
                  description: {
                    type: 'STRING' as const,
                    description: 'Detailed description of the fix'
                  },
                  codeSnippet: {
                    type: 'STRING' as const,
                    description: 'Code snippet showing the fix'
                  }
                }
              }
            }
          }
        },
        passed: {
          type: 'BOOLEAN' as const,
          description: 'Whether the code passed review (true if no critical issues)'
        }
      },
      required: ['summary', 'issues', 'passed']
    };

    // Call Gemini with structured output
    const response = await client.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema
      }
    });

    // Parse the response
    const text = response.text;
    if (!text) {
      throw new Error('Gemini returned an empty response');
    }
    let parsedResponse: GeminiReviewResponse;
    try {
      parsedResponse = JSON.parse(text);
    } catch (error) {
      throw new Error(`Failed to parse Gemini response as JSON: ${text}`);
    }

    // Convert Gemini issues to ReviewIssue format
    const issues: ReviewIssue[] = [];
    for (const geminiIssue of parsedResponse.issues) {
      const severity = geminiIssue.severity === 'error'
        ? DiagnosticSeverity.Error
        : DiagnosticSeverity.Warning;

      const issue: ReviewIssue = {
        code: geminiIssue.code,
        message: geminiIssue.message,
        severity,
        file: geminiIssue.file,
        line: geminiIssue.line,
        character: geminiIssue.character,
        endLine: geminiIssue.endLine,
        endCharacter: geminiIssue.endCharacter,
        category: geminiIssue.category,
        source: 'gemini'
      };

      // Add suggested fix if provided
      if (geminiIssue.suggestedFix) {
        issue.suggestedFix = {
          title: geminiIssue.suggestedFix.title,
          edits: [] // Edits will be computed by the server when applying the fix
        };
      }

      issues.push(issue);
    }

    const durationMs = Date.now() - startTime;

    return {
      issues,
      summary: parsedResponse.summary,
      passed: parsedResponse.passed,
      durationMs,
      rawResponse: parsedResponse
    };
  }

  /**
   * Builds the review prompt for Gemini.
   */
  private buildReviewPrompt(
    fileDiff: FileDiff,
    teamRules: string | null,
    fileContent?: string
  ): string {
    let prompt = `You are an expert code reviewer. Review the following git diff and provide structured feedback.\n\n`;

    prompt += `## File: ${fileDiff.filePath}\n`;
    prompt += `## Status: ${fileDiff.isNew ? 'New file' : fileDiff.isDeleted ? 'Deleted' : 'Modified'}\n\n`;

    prompt += `## Diff:\n\`\`\`diff\n${fileDiff.diff}\n\`\`\`\n\n`;

    if (fileContent && !fileDiff.isNew) {
      prompt += `## Full File Context:\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
    }

    if (teamRules) {
      prompt += `## Team Review Rules:\n${teamRules}\n\n`;
    }

    prompt += `## Instructions:\n`;
    prompt += `- Identify potential bugs, security issues, performance problems, and code quality concerns\n`;
    prompt += `- Check for adherence to best practices\n`;
    prompt += `- If team rules are provided, ensure the code follows them\n`;
    prompt += `- Provide specific line numbers for issues\n`;
    prompt += `- Suggest fixes where applicable\n`;
    prompt += `- Return issues as a JSON array with the schema provided\n`;

    return prompt;
  }

  /**
   * Runs Fast-Gate analysis on multiple files.
   */
  async analyzeBatch(fileDiffs: FileDiff[]): Promise<Map<string, AnalysisResult>> {
    const results = new Map<string, AnalysisResult>();

    for (const fileDiff of fileDiffs) {
      try {
        const result = await this.analyze(fileDiff);
        results.set(fileDiff.filePath, result);
      } catch (error) {
        console.error(`[Sentinel] Failed to analyze ${fileDiff.filePath}:`, error);
        results.set(fileDiff.filePath, {
          allIssues: [],
          allPassed: false,
          totalDurationMs: 0
        });
      }
    }

    return results;
  }
}
