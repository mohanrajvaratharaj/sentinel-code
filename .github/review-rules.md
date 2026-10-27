# Team Code Review Rules

This file defines custom code review rules for your team. Sentinel will use these rules when running AI-powered code reviews with Gemini.

## General Guidelines

- All public APIs must have JSDoc/TSDoc comments
- Error handling must be explicit — no silent catches
- Use meaningful variable and function names
- Keep functions small and focused (single responsibility)

## Security Rules

- Never hardcode secrets, API keys, or credentials
- Always validate and sanitize user input
- Use parameterized queries for database operations
- Avoid using `eval()` or dynamic code execution

## Performance Rules

- Avoid N+1 query patterns
- Use caching for expensive operations
- Implement pagination for large datasets
- Avoid blocking the event loop with synchronous operations

## Code Quality Rules

- Follow the existing code style in the project
- Write tests for new features and bug fixes
- Use TypeScript strict mode features
- Avoid using `any` type — use proper type definitions
- Handle edge cases and boundary conditions

## Testing Rules

- Unit tests should be isolated and deterministic
- Integration tests should cover critical paths
- Mock external dependencies in unit tests
- Test error paths and edge cases

## Example Custom Rules

Add your team-specific rules below:

```
- Rule: All database queries must use the repository pattern
- Rule: API responses must follow the standard envelope format
- Rule: Log all external API calls with correlation IDs
```
