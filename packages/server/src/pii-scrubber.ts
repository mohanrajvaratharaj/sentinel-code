/**
 * PII (Personally Identifiable Information) Scrubber Module
 *
 * Detects and redacts sensitive data from diff content before sending
 * it to external APIs like Gemini. This prevents accidental leakage of:
 * - API keys and secrets
 * - Internal IP addresses
 * - Private string constants (passwords, tokens)
 * - Email addresses and phone numbers
 * - File paths that may contain usernames
 */

/**
 * A PII pattern definition for detection and redaction.
 */
export interface PIIPattern {
  /** Unique identifier for the pattern type */
  id: string;
  /** Human-readable category name */
  category: string;
  /** Regex pattern to match sensitive data */
  pattern: RegExp;
  /** Replacement string (default: [REDACTED_<category>]) */
  replacement?: string;
  /** Whether this pattern should only match in added lines (+) of a diff */
  addedLinesOnly?: boolean;
}

/**
 * Result of scrubbing an input string.
 */
export interface ScrubResult {
  /** The scrubbed content */
  content: string;
  /** Number of redactions made */
  redactionCount: number;
  /** List of categories that were redacted */
  redactedCategories: string[];
  /** Whether any redactions were made */
  wasModified: boolean;
}

/**
 * Configuration for PII scrubbing behavior.
 */
export interface PIIScrubberConfig {
  /** Whether to enable PII scrubbing (default: true) */
  enabled?: boolean;
  /** Custom patterns to add alongside built-in patterns */
  customPatterns?: PIIPattern[];
  /** Categories to exclude from scrubbing */
  excludedCategories?: string[];
  /** Whether to redact file paths containing usernames (default: true) */
  redactFilePaths?: boolean;
}

export const DEFAULT_SCRUBBER_CONFIG: PIIScrubberConfig = {
  enabled: true,
  redactFilePaths: true
};

/**
 * Built-in PII detection patterns.
 * These are applied to diff content before sending to external APIs.
 */
export const BUILTIN_PII_PATTERNS: PIIPattern[] = [
  {
    id: 'api-key-generic',
    category: 'api-key',
    pattern: /\b(api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"]?([A-Za-z0-9_\-./+=]{16,})['"]?/gi,
    replacement: '[REDACTED_API_KEY]'
  },
  {
    id: 'openai-key',
    category: 'api-key',
    pattern: /sk-[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED_API_KEY]'
  },
  {
    id: 'google-api-key',
    category: 'api-key',
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    replacement: '[REDACTED_API_KEY]'
  },
  {
    id: 'aws-access-key',
    category: 'api-key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '[REDACTED_API_KEY]'
  },
  {
    id: 'aws-secret-key',
    category: 'api-key',
    pattern: /\b([A-Za-z0-9/+=]{40})\b/g,
    replacement: '[REDACTED_API_KEY]'
  },
  {
    id: 'github-token',
    category: 'api-key',
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    replacement: '[REDACTED_API_KEY]'
  },
  {
    id: 'slack-token',
    category: 'api-key',
    pattern: /xox[baprs]-[0-9a-zA-Z-]{10,}/g,
    replacement: '[REDACTED_API_KEY]'
  },
  {
    id: 'jwt-token',
    category: 'api-key',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: '[REDACTED_API_KEY]'
  },
  {
    id: 'password-assignment',
    category: 'password',
    pattern: /\b(password|passwd|pwd|secret|private[_-]?key)\s*[:=]\s*['"][^'"]{4,}['"]/gi,
    replacement: '[REDACTED_PASSWORD]'
  },
  {
    id: 'connection-string',
    category: 'connection-string',
    pattern: /(mongodb|postgres|mysql|redis|amqp):\/\/[^'\s]+:[^'\s]+@/gi,
    replacement: '[REDACTED_CONNECTION_STRING]@'
  },
  {
    id: 'bearer-token',
    category: 'api-key',
    pattern: /Bearer\s+[A-Za-z0-9_\-./+=]{20,}/gi,
    replacement: 'Bearer [REDACTED_API_KEY]'
  },
  {
    id: 'private-ip',
    category: 'ip-address',
    pattern: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    replacement: '[REDACTED_IP]'
  },
  {
    id: 'email',
    category: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: '[REDACTED_EMAIL]'
  },
  {
    id: 'phone-number',
    category: 'phone-number',
    pattern: /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: '[REDACTED_PHONE]'
  },
  {
    id: 'credit-card',
    category: 'credit-card',
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    replacement: '[REDACTED_CC]'
  },
  {
    id: 'ssh-private-key',
    category: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]'
  },
  {
    id: 'dotenv-value',
    category: 'secret',
    pattern: /^\s*(?:DATABASE_URL|STRIPE_SECRET|SENDGRID_API|TWILIO_AUTH|NGROK_TOKEN)\s*[:=]\s*['"]?[^'"\s]+['"]?/gm,
    replacement: '[REDACTED_SECRET]'
  }
];

/**
 * PII Scrubber class for redacting sensitive data from diff content.
 */
export class PIIScrubber {
  private config: PIIScrubberConfig;
  private patterns: PIIPattern[];

  constructor(config: PIIScrubberConfig = DEFAULT_SCRUBBER_CONFIG) {
    this.config = { ...DEFAULT_SCRUBBER_CONFIG, ...config };
    this.patterns = this.buildPatternList();
  }

  /**
   * Build the final list of patterns, merging built-in and custom patterns.
   */
  private buildPatternList(): PIIPattern[] {
    const excluded = new Set(this.config.excludedCategories || []);

    let patterns = BUILTIN_PII_PATTERNS.filter(
      p => !excluded.has(p.category)
    );

    // Add custom patterns
    if (this.config.customPatterns && this.config.customPatterns.length > 0) {
      patterns = patterns.concat(
        this.config.customPatterns.filter(p => !excluded.has(p.category))
      );
    }

    return patterns;
  }

  /**
   * Scrub PII from a string of content.
   *
   * @param content - The content to scrub
   * @returns ScrubResult with the scrubbed content and metadata
   */
  scrub(content: string): ScrubResult {
    if (!this.config.enabled) {
      return {
        content,
        redactionCount: 0,
        redactedCategories: [],
        wasModified: false
      };
    }

    let modified = content;
    let totalRedactions = 0;
    const redactedCategories = new Set<string>();

    for (const pattern of this.patterns) {
      const replacement = pattern.replacement || `[REDACTED_${pattern.category.toUpperCase()}]`;

      // Reset regex state for global matches
      const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
      let matchCount = 0;

      modified = modified.replace(regex, () => {
        matchCount++;
        redactedCategories.add(pattern.category);
        return replacement;
      });

      totalRedactions += matchCount;
    }

    return {
      content: modified,
      redactionCount: totalRedactions,
      redactedCategories: Array.from(redactedCategories),
      wasModified: totalRedactions > 0
    };
  }

  /**
   * Scrub PII from a diff string, preserving diff structure.
   * Only scrubs added lines (+) by default to avoid modifying
   * the context of existing code.
   *
   * @param diff - The unified diff content
   * @returns ScrubResult with the scrubbed diff
   */
  scrubDiff(diff: string): ScrubResult {
    if (!this.config.enabled) {
      return {
        content: diff,
        redactionCount: 0,
        redactedCategories: [],
        wasModified: false
      };
    }

    const lines = diff.split('\n');
    let totalRedactions = 0;
    const redactedCategories = new Set<string>();

    const scrubbedLines = lines.map(line => {
      // Only scrub added lines to preserve context integrity
      if (line.startsWith('+') && line.length > 1) {
        const lineContent = line.substring(1);
        const result = this.scrub(lineContent);
        if (result.wasModified) {
          totalRedactions += result.redactionCount;
          for (const cat of result.redactedCategories) {
            redactedCategories.add(cat);
          }
          return '+' + result.content;
        }
      }
      return line;
    });

    return {
      content: scrubbedLines.join('\n'),
      redactionCount: totalRedactions,
      redactedCategories: Array.from(redactedCategories),
      wasModified: totalRedactions > 0
    };
  }

  /**
   * Scrub file paths to remove username components.
   * e.g., /Users/johndoe/Documents/project -> /Users/[REDACTED_USER]/Documents/project
   */
  scrubFilePath(filePath: string): string {
    if (!this.config.redactFilePaths) {
      return filePath;
    }

    // Match common home directory patterns
    return filePath
      .replace(/(\/Users\/)[^/]+/g, '$1[REDACTED_USER]')
      .replace(/(\/home\/)[^/]+/g, '$1[REDACTED_USER]')
      .replace(/(C:\\Users\\)[^\\]+/g, '$1[REDACTED_USER]');
  }

  /**
   * Quick check if content likely contains PII without full scrubbing.
   * Useful for early-exit optimization.
   *
   * @param content - The content to check
   * @returns True if PII patterns are likely present
   */
  hasPotentialPII(content: string): boolean {
    const quickCheckPatterns = [
      /\b(api[_-]?key|secret|password|token)\s*[:=]/i,
      /sk-[A-Za-z0-9]{20,}/,
      /AKIA[0-9A-Z]{16}/,
      /Bearer\s+[A-Za-z0-9]/i,
      /mongodb:\/\/|postgres:\/\/|mysql:\/\//,
      /-----BEGIN.*PRIVATE KEY-----/
    ];

    return quickCheckPatterns.some(pattern => pattern.test(content));
  }
}

/**
 * Convenience function to create a scrubber with default config and scrub content.
 *
 * @param content - The content to scrub
 * @param config - Optional configuration overrides
 * @returns ScrubResult with the scrubbed content
 */
export function scrubPII(content: string, config?: PIIScrubberConfig): ScrubResult {
  const scrubber = new PIIScrubber(config);
  return scrubber.scrub(content);
}

/**
 * Convenience function to scrub a diff string.
 *
 * @param diff - The unified diff content
 * @param config - Optional configuration overrides
 * @returns ScrubResult with the scrubbed diff
 */
export function scrubDiffPII(diff: string, config?: PIIScrubberConfig): ScrubResult {
  const scrubber = new PIIScrubber(config);
  return scrubber.scrubDiff(diff);
}
