/**
 * Automated Test Generation Module
 *
 * Generates unit test scaffolds (Jest for TypeScript/JavaScript, PyTest for Python)
 * based on review issues flagged by Gemini or Fast-Gate. These are exposed as
 * 1-click QuickFix code actions in the IDE.
 *
 * Supported test frameworks:
 * - Jest (TypeScript, JavaScript)
 * - PyTest (Python)
 */

import { ReviewIssue } from './types';
import { TextEdit } from 'vscode-languageserver';

/**
 * Configuration for test generation.
 */
export interface TestGeneratorConfig {
  /** Default test framework to use (overrides auto-detection) */
  framework?: 'jest' | 'pytest';
  /** Test directory pattern (default: __tests__ for JS, tests/ for Python) */
  testDirectory?: string;
  /** Whether to include async test wrappers (default: true) */
  includeAsyncWrappers?: boolean;
  /** Whether to include edge case tests (default: true) */
  includeEdgeCases?: boolean;
}

export const DEFAULT_TEST_CONFIG: TestGeneratorConfig = {
  includeAsyncWrappers: true,
  includeEdgeCases: true
};

/**
 * A generated test scaffold result.
 */
export interface GeneratedTest {
  /** The test file content */
  content: string;
  /** Suggested file path for the test */
  suggestedPath: string;
  /** The test framework used */
  framework: 'jest' | 'pytest';
  /** Number of test cases generated */
  testCaseCount: number;
  /** Description of what the tests cover */
  description: string;
}

/**
 * Determine the test framework based on file extension.
 */
export function detectFramework(filePath: string): 'jest' | 'pytest' | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return 'jest';
    case 'py':
      return 'pytest';
    default:
      return null;
  }
}

/**
 * Generate a suggested test file path based on the source file.
 */
export function suggestTestPath(filePath: string, framework: 'jest' | 'pytest'): string {
  const ext = filePath.split('.').pop();
  const nameWithoutExt = filePath.substring(0, filePath.lastIndexOf('.'));

  if (framework === 'jest') {
    // Jest convention: place test alongside source or in __tests__/
    const baseName = nameWithoutExt.split('/').pop() || nameWithoutExt;
    const dir = nameWithoutExt.substring(0, nameWithoutExt.lastIndexOf('/')) || '.';
    return `${dir}/__tests__/${baseName}.test.${ext}`;
  } else {
    // PyTest convention: tests/ directory with test_<name>.py
    const baseName = nameWithoutExt.split('/').pop() || nameWithoutExt;
    return `tests/test_${baseName}.py`;
  }
}

/**
 * Extract function names from file content for test generation.
 */
function extractFunctionNames(content: string, framework: 'jest' | 'pytest'): string[] {
  const functions = new Set<string>();

  if (framework === 'jest') {
    // TypeScript/JavaScript function patterns
    const patterns = [
      /(?:export\s+)?function\s+(\w+)/g,
      /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/g,
      /(?:export\s+)?class\s+(\w+)/g,
      /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/gm
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1];
        if (!['if', 'for', 'while', 'switch', 'catch'].includes(name)) {
          functions.add(name);
        }
      }
    }
  } else {
    // Python function patterns
    const pattern = /^\s*def\s+(\w+)\s*\(/gm;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (!name.startsWith('_')) {
        functions.add(name);
      }
    }
  }

  return Array.from(functions);
}

/**
 * Extract function signatures for parameter inference.
 */
function extractFunctionSignatures(content: string, framework: 'jest' | 'pytest'): Map<string, string[]> {
  const signatures = new Map<string, string[]>();

  if (framework === 'jest') {
    // Match function declarations with parameters
    const pattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      const params = match[2]
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(p => p.split(':')[0].split('=')[0].trim());
      signatures.set(name, params);
    }

    // Match arrow functions
    const arrowPattern = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)/g;
    while ((match = arrowPattern.exec(content)) !== null) {
      const name = match[1];
      const params = match[2]
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(p => p.split(':')[0].split('=')[0].trim());
      if (params.length > 0) {
        signatures.set(name, params);
      }
    }
  } else {
    // Python function signatures
    const pattern = /^\s*def\s+(\w+)\s*\(([^)]*)\)/gm;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      const params = match[2]
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(p => p.split('=')[0].split(':')[0].trim())
        .filter(p => p !== 'self' && p !== 'cls');
      if (params.length > 0) {
        signatures.set(name, params);
      }
    }
  }

  return signatures;
}

/**
 * Generate Jest test scaffold content.
 */
function generateJestTests(
  filePath: string,
  content: string,
  issues: ReviewIssue[],
  config: TestGeneratorConfig
): GeneratedTest {
  const functions = extractFunctionNames(content, 'jest');
  const signatures = extractFunctionSignatures(content, 'jest');
  const baseName = filePath.split('/').pop()?.replace(/\.(ts|js|tsx|jsx)$/, '') || 'module';
  const testPath = suggestTestPath(filePath, 'jest');

  let testContent = `// Auto-generated test scaffold by Sentinel Code Review
// Generated to address review issues - please customize as needed

import { ${functions.join(', ')} } from '../${baseName}';

describe('${baseName}', () => {
`;

  let testCaseCount = 0;

  // Generate tests based on detected functions
  for (const funcName of functions) {
    const params = signatures.get(funcName) || [];
    const paramValues = params.map(p => {
      // Infer simple default values based on parameter name
      if (p.includes('id') || p.includes('num') || p.includes('count')) return '1';
      if (p.includes('name') || p.includes('str') || p.includes('text') || p.includes('msg')) return "'test'";
      if (p.includes('flag') || p.includes('enabled') || p.includes('active')) return 'true';
      if (p.includes('list') || p.includes('items') || p.includes('array')) return '[]';
      if (p.includes('data') || p.includes('config') || p.includes('options')) return '{}';
      return `/* ${p} */`;
    });

    testContent += `  describe('${funcName}', () => {
`;
    testCaseCount++;

    // Basic happy path test
    testContent += `    it('should work with valid input', () => {
      const result = ${funcName}(${paramValues.join(', ')});
      expect(result).toBeDefined();
    });
`;

    // Edge case tests if enabled
    if (config.includeEdgeCases) {
      testContent += `
    it('should handle empty input', () => {
      // TODO: Add assertion based on expected behavior
      expect(() => ${funcName}()).not.toThrow();
    });
`;
      testCaseCount++;

      if (config.includeAsyncWrappers) {
        testContent += `
    it('should handle async operations correctly', async () => {
      // TODO: Add async test assertions
      const result = await ${funcName}(${paramValues.join(', ')});
      expect(result).toBeDefined();
    });
`;
        testCaseCount++;
      }
    }

    testContent += `  });
`;
  }

  // Generate tests based on review issues
  for (const issue of issues) {
    if (issue.category === 'security' && issue.message.toLowerCase().includes('sql')) {
      testContent += `
  describe('SQL injection prevention', () => {
    it('should not allow SQL injection via user input', () => {
      const maliciousInput = "' OR '1'='1";
      // TODO: Verify that the function properly sanitizes input
      // expect(() => functionWithQuery(maliciousInput)).toThrow();
    });
  });
`;
      testCaseCount++;
    }

    if (issue.message.toLowerCase().includes('error handling') || issue.message.toLowerCase().includes('try')) {
      testContent += `
  describe('error handling', () => {
    it('should handle errors gracefully', () => {
      // TODO: Test error handling paths
      expect(() => {
        // Trigger error condition
      }).not.toThrow();
    });
  });
`;
      testCaseCount++;
    }

    if (issue.message.toLowerCase().includes('promise') || issue.message.toLowerCase().includes('async')) {
      testContent += `
  describe('promise handling', () => {
    it('should handle rejected promises', async () => {
      // TODO: Test promise rejection handling
      await expect(Promise.reject(new Error('test'))).rejects.toThrow();
    });
  });
`;
      testCaseCount++;
    }
  }

  testContent += `});
`;

  return {
    content: testContent,
    suggestedPath: testPath,
    framework: 'jest',
    testCaseCount,
    description: `Generated ${testCaseCount} test cases for ${functions.length} functions and ${issues.length} review issues`
  };
}

/**
 * Generate PyTest test scaffold content.
 */
function generatePyTestTests(
  filePath: string,
  content: string,
  issues: ReviewIssue[],
  config: TestGeneratorConfig
): GeneratedTest {
  const functions = extractFunctionNames(content, 'pytest');
  const signatures = extractFunctionSignatures(content, 'pytest');
  const baseName = filePath.split('/').pop()?.replace('.py', '') || 'module';
  const testPath = suggestTestPath(filePath, 'pytest');

  let testContent = `"""
Auto-generated test scaffold by Sentinel Code Review
Generated to address review issues - please customize as needed
"""

import pytest
from ${baseName.replace(/\//g, '.')} import ${functions.join(', ')}


`;

  let testCaseCount = 0;

  // Generate tests based on detected functions
  for (const funcName of functions) {
    const params = signatures.get(funcName) || [];
    const paramValues = params.map(p => {
      if (p.includes('id') || p.includes('num') || p.includes('count')) return '1';
      if (p.includes('name') || p.includes('str') || p.includes('text') || p.includes('msg')) return "'test'";
      if (p.includes('flag') || p.includes('enabled') || p.includes('active')) return 'True';
      if (p.includes('list') || p.includes('items') || p.includes('array')) return '[]';
      if (p.includes('data') || p.includes('config') || p.includes('options')) return '{}';
      return 'None';
    });

    // Basic test
    const testName = `test_${funcName}_basic`;
    testContent += `def ${testName}():
    """Test ${funcName} with valid input."""
    result = ${funcName}(${paramValues.join(', ')})
    assert result is not None


`;
    testCaseCount++;

    // Edge case tests if enabled
    if (config.includeEdgeCases) {
      testContent += `def test_${funcName}_empty_input():
    """Test ${funcName} with empty/None input."""
    # TODO: Add assertion based on expected behavior
    try:
        ${funcName}()
    except (TypeError, ValueError):
        pass  # Expected behavior for invalid input


`;
      testCaseCount++;
    }
  }

  // Generate tests based on review issues
  for (const issue of issues) {
    if (issue.category === 'security' && issue.message.toLowerCase().includes('sql')) {
      testContent += `def test_sql_injection_prevention():
    """Test that SQL injection attempts are properly handled."""
    malicious_input = "' OR '1'='1"
    # TODO: Verify that the function properly sanitizes input
    # with pytest.raises(Exception):
    #     function_with_query(malicious_input)


`;
      testCaseCount++;
    }

    if (issue.message.toLowerCase().includes('error handling')) {
      testContent += `def test_error_handling():
    """Test that errors are handled gracefully."""
    # TODO: Test error handling paths
    # with pytest.raises(ExpectedError):
    #     function_that_might_fail()
    pass


`;
      testCaseCount++;
    }

    if (issue.message.toLowerCase().includes('async') || issue.message.toLowerCase().includes('await')) {
      testContent += `@pytest.mark.asyncio
async def test_async_operations():
    """Test async operations and error handling."""
    # TODO: Add async test assertions
    # result = await async_function()
    # assert result is not None
    pass


`;
      testCaseCount++;
    }
  }

  return {
    content: testContent,
    suggestedPath: testPath,
    framework: 'pytest',
    testCaseCount,
    description: `Generated ${testCaseCount} test cases for ${functions.length} functions and ${issues.length} review issues`
  };
}

/**
 * Main function to generate test scaffolds based on review issues.
 *
 * @param filePath - The source file path
 * @param fileContent - The current file content
 * @param issues - Review issues that triggered test generation
 * @param config - Test generation configuration
 * @returns Generated test scaffold or null if framework is not supported
 */
export function generateTestScaffold(
  filePath: string,
  fileContent: string,
  issues: ReviewIssue[],
  config: TestGeneratorConfig = DEFAULT_TEST_CONFIG
): GeneratedTest | null {
  const framework = config.framework || detectFramework(filePath);
  if (!framework) {
    return null;
  }

  if (framework === 'jest') {
    return generateJestTests(filePath, fileContent, issues, config);
  } else {
    return generatePyTestTests(filePath, fileContent, issues, config);
  }
}

/**
 * Generate a TextEdit for inserting a test file as a QuickFix.
 * This creates a new file with the generated test content.
 *
 * @param generatedTest - The generated test scaffold
 * @param uri - The URI of the source file
 * @returns TextEdit for the new test file
 */
export function createTestFileTextEdit(generatedTest: GeneratedTest): {
  uri: string;
  edits: TextEdit[];
  title: string;
} {
  // Create a URI for the new test file
  const testUri = `file:///${generatedTest.suggestedPath}`;

  // Create a TextEdit that inserts the entire file content at position 0
  const edit: TextEdit = {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 }
    },
    newText: generatedTest.content
  };

  return {
    uri: testUri,
    edits: [edit],
    title: `🧪 Generate test file: ${generatedTest.suggestedPath} (${generatedTest.testCaseCount} tests)`
  };
}

/**
 * Check if any of the issues would benefit from test generation.
 *
 * @param issues - Review issues to check
 * @returns True if test generation is recommended
 */
export function shouldSuggestTests(issues: ReviewIssue[]): boolean {
  const testRelevantCategories = [
    'security',
    'error-handling',
    'best-practice',
    'type-safety',
    'code-quality'
  ];

  const testRelevantKeywords = [
    'error handling',
    'edge case',
    'test',
    'promise',
    'async',
    'sql',
    'injection',
    'validation',
    'input',
    'throw',
    'exception'
  ];

  for (const issue of issues) {
    // Check category
    if (issue.category && testRelevantCategories.includes(issue.category.toLowerCase())) {
      return true;
    }

    // Check message content
    const message = issue.message.toLowerCase();
    if (testRelevantKeywords.some(keyword => message.includes(keyword))) {
      return true;
    }
  }

  return false;
}
