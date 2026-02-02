# Test Suite Documentation

## Running Tests

```bash
# Run tests in watch mode
npm test

# Run tests once
npm run test:run

# Run tests with UI
npm run test:ui

# Run tests with coverage
npm run test:coverage
```

## Test Structure

- `tests/skills/` - Skill-specific tests
- `tests/utils/` - Shared test utilities and helpers
- `tests/*/mocks/` - Mock objects and fixtures

## Writing New Tests

1. Create test file: `tests/skills/[skill-name]/[skill-name].test.ts`
2. Import the skill's execute function and InputSchema
3. Create mocks using utilities from `tests/utils/test-helpers.ts`
4. Write test cases using Vitest's `describe`, `it`, `expect`

## Web-Fetch Test Cases

### Test Case 1: Successful Fetch
- **URL:** https://kexue.fm
- **Expected:** Successfully fetch content using Jina
- **Verifies:** Basic fetch functionality works

### Test Case 2: 403 Fallback
- **Scenario:** Jina returns 403 Forbidden
- **Expected:** Automatically fallback to Browserless
- **Verifies:** Fallback mechanism works for HTTP errors

### Test Case 3: Timeout No Fallback
- **Scenario:** Jina times out
- **Expected:** NO fallback to Browserless (fail fast)
- **Verifies:** Timeout errors don't trigger fallback

### Additional Test Cases
- Network error handling with fallback
- Input schema validation
- Private IP blocking (192.168.x.x, localhost)
- JSON content type handling
- Response size limit enforcement

## Mocking Strategy

### Obsidian API Mocking
- Mock `requestUrl` function to simulate HTTP responses
- Mock `Plugin` and `SkillContext` for dependency injection
- Use `vi.mock()` for module-level mocking

### Test Isolation
- Each test case clears mocks with `beforeEach`
- Tests don't depend on external services
- Tests run fast and reliably

## Test Coverage Goals

- **Happy path:** Successful fetches with all strategies
- **Error handling:** HTTP errors, network errors, timeouts
- **Fallback logic:** Verify correct fallback behavior
- **Edge cases:** Private IPs, invalid URLs, missing API keys
- **Input validation:** Schema validation works correctly

## Future Enhancements

1. **Integration tests:** Test with real HTTP calls (optional, slower)
2. **Performance tests:** Measure execution time
3. **Snapshot tests:** Verify HTML to Markdown conversion
4. **E2E tests:** Test through the full skill execution pipeline
