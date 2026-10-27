// Test file with intentional issues for sentinel-code review

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
