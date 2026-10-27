#!/usr/bin/env node

/**
 * Test script for sentinel-code LSP server
 * This script demonstrates how to test the server's functionality
 */

const fs = require('fs');
const path = require('path');

async function runTests() {
  // Test configuration
  const testDir = path.join(__dirname, 'test-fixtures');
  const testFile = path.join(testDir, 'test-example.ts');

  console.log('🔍 Sentinel Code Review - Test Suite\n');
  console.log('='.repeat(60));

  // Step 1: Create test fixtures directory
  console.log('\n[1/4] Setting up test fixtures...');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  // Step 2: Create a test file with intentional issues
  const testCode = `// Test file with intentional issues for sentinel-code review

// Issue 1: Hardcoded secret (should trigger FAST_GATE_SECRET)
const apiKey = 'sk-proj-abc123def456ghi789';

// Issue 2: console.log (should trigger FAST_GATE_CONSOLE_LOG)
console.log('Debugging information:', someVariable);

// Issue 3: TODO comment (should trigger FAST_GATE_TODO)
// TODO: Implement proper error handling

// Issue 4: any type (should trigger FAST_GATE_ANY_TYPE)
function processData(data: any) {
  return data;
}

// Issue 5: Potential SQL injection (should trigger FAST_GATE_RAW_SQL)
const query = 'SELECT * FROM users WHERE id = ' + userId;

// Issue 6: eval usage (should trigger FAST_GATE_EVAL)
eval(userInput);

// This is a legitimate function
function calculateTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}
`;

  fs.writeFileSync(testFile, testCode);
  console.log(`✓ Created test file: ${testFile}`);

  // Step 3: Test Fast-Gate analysis directly
  console.log('\n[2/4] Testing Fast-Gate static analysis...');
  try {
    // Import and test the analyzer directly
    const { Analyzer } = require('../packages/server/dist/analyzer.js');
    const { BUILTIN_FAST_GATE_RULES } = require('../packages/server/dist/types.js');
    
    console.log(`✓ Loaded ${BUILTIN_FAST_GATE_RULES.length} built-in Fast-Gate rules:`);
    BUILTIN_FAST_GATE_RULES.forEach(rule => {
      console.log(`  - ${rule.id}: ${rule.name}`);
    });
    
    // Create an analyzer instance
    const analyzer = new Analyzer({
      workspaceRoot: testDir,
      enableFastGate: true,
      enableGeminiReview: false, // Skip Gemini for this test
      maxDiffSizeBytes: 1024 * 1024
    });
    
    // Create a mock file diff
    const fileDiff = {
      filePath: 'test-example.ts',
      diff: testCode,
      isNew: true,
      isDeleted: false
    };
    
    // Run analysis
    console.log('\nRunning Fast-Gate analysis...');
    const result = await analyzer.analyze(fileDiff, testCode);
    
    console.log(`\n✓ Analysis complete in ${result.totalDurationMs}ms`);
    console.log(`✓ Found ${result.allIssues.length} issues:`);
    
    result.allIssues.forEach((issue, index) => {
      const severity = issue.severity === 0 ? '🔴 ERROR' : '🟡 WARNING';
      console.log(`\n  ${index + 1}. ${severity} ${issue.code}`);
      console.log(`     Message: ${issue.message}`);
      if (issue.line) {
        console.log(`     Location: Line ${issue.line}, Character ${issue.character}`);
      }
      console.log(`     Category: ${issue.category}`);
    });
    
    console.log('\n✓ Fast-Gate test PASSED');
    
  } catch (error) {
    console.error('✗ Fast-Gate test FAILED:', error.message);
    console.error(error.stack);
  }

  // Step 4: Test Gemini AI review (if API key is set)
  console.log('\n[3/4] Testing Gemini AI review...');
  if (process.env.GEMINI_API_KEY) {
    console.log('✓ GEMINI_API_KEY is set, testing AI review...');
    
    try {
      const { Analyzer } = require('../packages/server/dist/analyzer.js');
      
      const analyzer = new Analyzer({
        workspaceRoot: testDir,
        enableFastGate: false, // Skip Fast-Gate to test only Gemini
        enableGeminiReview: true,
        maxDiffSizeBytes: 1024 * 1024
      });
      
      const fileDiff = {
        filePath: 'test-example.ts',
        diff: testCode,
        isNew: true,
        isDeleted: false
      };
      
      console.log('Sending to Gemini for review...');
      const result = await analyzer.analyze(fileDiff, testCode);
      
      console.log(`\n✓ Gemini review complete in ${result.totalDurationMs}ms`);
      
      if (result.gemini) {
        console.log(`\nGemini Summary: ${result.gemini.summary}`);
        console.log(`\nGemini found ${result.gemini.issues.length} issues:`);
        
        result.gemini.issues.forEach((issue, index) => {
          const severity = issue.severity === 0 ? '🔴 ERROR' : '🟡 WARNING';
          console.log(`\n  ${index + 1}. ${severity} ${issue.code}`);
          console.log(`     Message: ${issue.message}`);
          if (issue.line) {
            console.log(`     Location: Line ${issue.line}`);
          }
        });
      }
      
      console.log('\n✓ Gemini AI review test PASSED');
      
    } catch (error) {
      console.error('✗ Gemini AI review test FAILED:', error.message);
    }
  } else {
    console.log('⚠ GEMINI_API_KEY not set, skipping AI review test');
    console.log('  Set it with: export GEMINI_API_KEY="your-key-here"');
  }

  // Step 5: Test LSP server communication
  console.log('\n[4/4] Testing LSP server communication...');
  console.log('To test the LSP server interactively:');
  console.log('');
  console.log('  1. Start the server:');
  console.log('     npx ts-node packages/server/src/server.ts --stdio');
  console.log('');
  console.log('  2. Send LSP messages (example):');
  console.log('     echo \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":1234}}\' | npx ts-node packages/server/src/server.ts --stdio');
  console.log('');
  console.log('  3. Or use the VS Code extension for full integration testing');

  // Cleanup
  console.log('\n' + '='.repeat(60));
  console.log('✅ Test suite complete!');
  console.log('\nTo run tests again:');
  console.log('  npm run build');
  console.log('  node test/test-server.js');
  console.log('');
  console.log('To test with Gemini AI:');
  console.log('  export GEMINI_API_KEY="your-key-here"');
  console.log('  node test/test-server.js');
}

runTests().catch(console.error);
