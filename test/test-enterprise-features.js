#!/usr/bin/env node

/**
 * Test script for sentinel-code enterprise features:
 * - Smart Diff Chunking
 * - PII Redaction
 * - Automated Test Generation
 */

const path = require('path');

async function runTests() {
  console.log('🔍 Sentinel Code Review - Enterprise Features Test Suite\n');
  console.log('='.repeat(60));

  // Load compiled modules
  const { chunkDiff, parseDiffHunks, stripWhitespaceNoise, buildCompactDiff, getDiffSummary } = 
    require('../packages/server/dist/diff-chunker.js');
  const { PIIScrubber, scrubDiffPII, scrubPII, BUILTIN_PII_PATTERNS } = 
    require('../packages/server/dist/pii-scrubber.js');
  const { generateTestScaffold, shouldSuggestTests, detectFramework, suggestTestPath } = 
    require('../packages/server/dist/test-generator.js');
  const { Analyzer } = require('../packages/server/dist/analyzer.js');
  const { BUILTIN_FAST_GATE_RULES } = require('../packages/server/dist/types.js');

  let passed = 0;
  let failed = 0;

  // ==========================================
  // Test 1: Diff Chunking
  // ==========================================
  console.log('\n[1/6] Testing Smart Diff Chunking...');
  try {
    const sampleDiff = `--- a/src/example.ts
+++ b/src/example.ts
@@ -1,5 +1,8 @@
 import { useState } from 'react';
 
+const API_KEY = 'sk-1234567890abcdef';
+
 function calculateTotal(items) {
   return items.reduce((sum, item) => sum + item, 0);
 }
@@ -10,6 +13,10 @@ function calculateTotal(items) {
   return total;
 }
 
+async function fetchData(url) {
+  const response = await fetch(url);
+  return response.json();
+}
+
 export { calculateTotal, fetchData };
`;

    const fileDiff = {
      filePath: 'src/example.ts',
      diff: sampleDiff,
      isNew: false,
      isDeleted: false,
      isRenamed: false
    };

    // Test parseDiffHunks
    const hunks = parseDiffHunks(sampleDiff);
    console.log(`  ✓ Parsed ${hunks.length} hunks from diff`);
    if (hunks.length !== 2) {
      throw new Error(`Expected 2 hunks, got ${hunks.length}`);
    }

    // Test function detection
    const functionHunks = hunks.filter(h => h.isInFunction);
    console.log(`  ✓ Detected ${functionHunks.length} function-level hunks`);

    // Test whitespace stripping
    const strippedHunks = stripWhitespaceNoise(hunks);
    console.log(`  ✓ Whitespace stripping works (${strippedHunks.length} hunks after strip)`);

    // Test chunking
    const chunks = chunkDiff(fileDiff);
    console.log(`  ✓ Chunked into ${chunks.length} chunk(s)`);
    if (chunks.length === 0) {
      throw new Error('Expected at least 1 chunk');
    }

    // Test compact diff
    const compact = buildCompactDiff(fileDiff);
    console.log(`  ✓ Compact diff generated (${compact.length} chars)`);

    // Test diff summary
    const summary = getDiffSummary(fileDiff);
    console.log(`  ✓ Diff summary: ${summary.totalAdded} added, ${summary.totalRemoved} removed`);

    console.log('  ✅ Diff Chunking test PASSED');
    passed++;
  } catch (error) {
    console.error('  ✗ Diff Chunking test FAILED:', error.message);
    failed++;
  }

  // ==========================================
  // Test 2: PII Scrubbing
  // ==========================================
  console.log('\n[2/6] Testing PII Scrubbing...');
  try {
    const scrubber = new PIIScrubber();

    // Test API key detection
    const testContent1 = "const apiKey = 'sk-proj-abc123def456ghi789';";
    const result1 = scrubber.scrub(testContent1);
    console.log(`  ✓ API key scrubbed: ${result1.wasModified ? 'YES' : 'NO'}`);
    if (!result1.wasModified) {
      throw new Error('Expected API key to be scrubbed');
    }
    console.log(`    Result: ${result1.content}`);

    // Test password detection
    const testContent2 = "const password = 'super_secret_password_123';";
    const result2 = scrubber.scrub(testContent2);
    console.log(`  ✓ Password scrubbed: ${result2.wasModified ? 'YES' : 'NO'}`);

    // Test connection string detection
    const testContent3 = "mongodb://admin:secretpass@localhost:27017/db";
    const result3 = scrubber.scrub(testContent3);
    console.log(`  ✓ Connection string scrubbed: ${result3.wasModified ? 'YES' : 'NO'}`);

    // Test private IP detection
    const testContent4 = "const host = '192.168.1.100';";
    const result4 = scrubber.scrub(testContent4);
    console.log(`  ✓ Private IP scrubbed: ${result4.wasModified ? 'YES' : 'NO'}`);

    // Test diff scrubbing (only added lines)
    const testDiff = `--- a/src/config.ts
+++ b/src/config.ts
@@ -1,3 +1,4 @@
 const port = 3000;
+const apiKey = 'sk-proj-abc123def456ghi789';
 const host = 'localhost';
`;
    const diffResult = scrubber.scrubDiff(testDiff);
    console.log(`  ✓ Diff PII scrubbed: ${diffResult.redactionCount} redaction(s)`);
    if (diffResult.redactionCount === 0) {
      throw new Error('Expected at least 1 redaction in diff');
    }

    // Test file path scrubbing
    const scrubbedPath = scrubber.scrubFilePath('/Users/johndoe/Documents/project/src/file.ts');
    console.log(`  ✓ File path scrubbed: ${scrubbedPath}`);
    if (scrubbedPath.includes('johndoe')) {
      throw new Error('Expected username to be redacted from path');
    }

    // Test quick PII check
    const hasPII = scrubber.hasPotentialPII("const apiKey = 'secret123';");
    console.log(`  ✓ Quick PII check: ${hasPII ? 'PII detected' : 'No PII'}`);

    // Test built-in pattern count
    console.log(`  ✓ Built-in PII patterns: ${BUILTIN_PII_PATTERNS.length}`);

    console.log('  ✅ PII Scrubbing test PASSED');
    passed++;
  } catch (error) {
    console.error('  ✗ PII Scrubbing test FAILED:', error.message);
    failed++;
  }

  // ==========================================
  // Test 3: PII Scrubber Config
  // ==========================================
  console.log('\n[3/6] Testing PII Scrubber Configuration...');
  try {
    // Test disabled scrubber
    const disabledScrubber = new PIIScrubber({ enabled: false });
    const result = disabledScrubber.scrub("const apiKey = 'secret123';");
    if (result.wasModified) {
      throw new Error('Disabled scrubber should not modify content');
    }
    console.log('  ✓ Disabled scrubber works correctly');

    // Test excluded categories
    const excludedScrubber = new PIIScrubber({ excludedCategories: ['ip-address'] });
    const ipResult = excludedScrubber.scrub("const host = '192.168.1.100';");
    if (ipResult.wasModified) {
      throw new Error('Excluded category should not be scrubbed');
    }
    console.log('  ✓ Excluded categories work correctly');

    console.log('  ✅ PII Scrubber Configuration test PASSED');
    passed++;
  } catch (error) {
    console.error('  ✗ PII Scrubber Configuration test FAILED:', error.message);
    failed++;
  }

  // ==========================================
  // Test 4: Test Generation
  // ==========================================
  console.log('\n[4/6] Testing Automated Test Generation...');
  try {
    const sampleCode = `// Example TypeScript file
import { useState } from 'react';

export function calculateTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}

export async function fetchData(url: string): Promise<any> {
  const response = await fetch(url);
  return response.json();
}

export class UserService {
  async getUser(id: number) {
    return { id, name: 'John' };
  }
}
`;

    const sampleIssues = [
      {
        code: 'missing-error-handling',
        message: 'Missing error handling for async operation',
        severity: 1,
        file: 'src/example.ts',
        source: 'gemini',
        category: 'error-handling'
      },
      {
        code: 'any-type',
        message: 'Usage of any type detected',
        severity: 2,
        file: 'src/example.ts',
        source: 'fast-gate',
        category: 'type-safety'
      }
    ];

    // Test framework detection
    const framework = detectFramework('src/example.ts');
    console.log(`  ✓ Detected framework: ${framework}`);
    if (framework !== 'jest') {
      throw new Error('Expected jest framework for .ts file');
    }

    // Test test path suggestion
    const testPath = suggestTestPath('src/example.ts', 'jest');
    console.log(`  ✓ Suggested test path: ${testPath}`);

    // Test shouldSuggestTests
    const shouldSuggest = shouldSuggestTests(sampleIssues);
    console.log(`  ✓ Should suggest tests: ${shouldSuggest ? 'YES' : 'NO'}`);
    if (!shouldSuggest) {
      throw new Error('Expected shouldSuggestTests to return true');
    }

    // Test test generation
    const generatedTest = generateTestScaffold('src/example.ts', sampleCode, sampleIssues);
    if (!generatedTest) {
      throw new Error('Expected test scaffold to be generated');
    }
    console.log(`  ✓ Generated ${generatedTest.testCaseCount} test cases`);
    console.log(`  ✓ Framework: ${generatedTest.framework}`);
    console.log(`  ✓ Description: ${generatedTest.description}`);

    // Verify test content contains expected patterns
    if (!generatedTest.content.includes('describe(')) {
      throw new Error('Expected Jest describe() block in generated test');
    }
    if (!generatedTest.content.includes('calculateTotal')) {
      throw new Error('Expected function name in generated test');
    }

    // Test Python framework
    const pyFramework = detectFramework('src/example.py');
    console.log(`  ✓ Python framework detected: ${pyFramework}`);

    const pyTest = generateTestScaffold('src/example.py', 'def hello(): pass', sampleIssues);
    if (pyTest && pyTest.framework !== 'pytest') {
      throw new Error('Expected pytest framework for .py file');
    }
    console.log(`  ✓ PyTest generation works`);

    console.log('  ✅ Automated Test Generation test PASSED');
    passed++;
  } catch (error) {
    console.error('  ✗ Automated Test Generation test FAILED:', error.message);
    failed++;
  }

  // ==========================================
  // Test 5: Analyzer Integration
  // ==========================================
  console.log('\n[5/6] Testing Analyzer Integration with PII Scrubbing...');
  try {
    const analyzer = new Analyzer({
      workspaceRoot: process.cwd(),
      enableFastGate: true,
      enableGeminiReview: false, // Skip Gemini for this test
      maxDiffSizeBytes: 1024 * 1024,
      piiScrubber: { enabled: true, redactFilePaths: true },
      diffChunker: { maxChunkSize: 4000, stripWhitespace: true, detectFunctions: true }
    });

    const testCode = `// Test file with intentional issues
const apiKey = 'sk-proj-abc123def456ghi789';
console.log('Debug:', someVar);
// TODO: Fix this
function processData(data: any) {
  return data;
}
`;

    const fileDiff = {
      filePath: 'test-example.ts',
      diff: testCode,
      isNew: true,
      isDeleted: false,
      isRenamed: false
    };

    const result = await analyzer.analyze(fileDiff, testCode);
    console.log(`  ✓ Analysis complete in ${result.totalDurationMs}ms`);
    console.log(`  ✓ Found ${result.allIssues.length} issues`);
    console.log(`  ✓ Fast-Gate passed: ${result.fastGate?.passed}`);

    if (result.allIssues.length === 0) {
      throw new Error('Expected at least some issues from Fast-Gate');
    }

    console.log('  ✅ Analyzer Integration test PASSED');
    passed++;
  } catch (error) {
    console.error('  ✗ Analyzer Integration test FAILED:', error.message);
    failed++;
  }

  // ==========================================
  // Test 6: Large Diff Chunking
  // ==========================================
  console.log('\n[6/6] Testing Large Diff Chunking...');
  try {
    // Create a large diff with multiple functions
    let largeDiff = '--- a/src/large.ts\n+++ b/src/large.ts\n';
    
    for (let i = 0; i < 20; i++) {
      largeDiff += `@@ -${i * 10},5 +${i * 10},8 @@\n`;
      largeDiff += ` function helper${i}() {\n`;
      largeDiff += `+  const x = ${i};\n`;
      largeDiff += `+  const y = ${i * 2};\n`;
      largeDiff += `+  return x + y;\n`;
      largeDiff += ` }\n`;
    }

    const largeFileDiff = {
      filePath: 'src/large.ts',
      diff: largeDiff,
      isNew: false,
      isDeleted: false,
      isRenamed: false
    };

    // Test with small chunk size to force multiple chunks
    const chunks = chunkDiff(largeFileDiff, { maxChunkSize: 500, stripWhitespace: true });
    console.log(`  ✓ Large diff chunked into ${chunks.length} chunk(s)`);
    
    if (chunks.length === 0) {
      throw new Error('Expected at least 1 chunk');
    }

    // Verify chunk properties
    for (const chunk of chunks) {
      console.log(`    Chunk ${chunk.chunkIndex + 1}: ${chunk.charCount} chars, ${chunk.functionNames.length} functions`);
    }

    console.log('  ✅ Large Diff Chunking test PASSED');
    passed++;
  } catch (error) {
    console.error('  ✗ Large Diff Chunking test FAILED:', error.message);
    failed++;
  }

  // ==========================================
  // Summary
  // ==========================================
  console.log('\n' + '='.repeat(60));
  console.log(`✅ Test suite complete!`);
  console.log(`   Passed: ${passed}/${passed + failed}`);
  console.log(`   Failed: ${failed}/${passed + failed}`);
  
  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. Please check the output above.');
    process.exit(1);
  }
}

runTests().catch(error => {
  console.error('Test suite error:', error);
  process.exit(1);
});
