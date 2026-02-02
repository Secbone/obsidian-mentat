# Web-Fetch Skill Tests

## Test Structure

### Unit Tests (`web-fetch.test.ts`)
- Uses mocked `requestUrl` for fast, deterministic testing
- Tests all core functionality with controlled responses
- 15 tests covering various scenarios

### Integration Tests (`web-fetch.integration.test.ts`)
- Uses real HTTP requests to verify actual functionality
- Tests against real websites
- 4 tests covering different strategies and URLs

## Known Limitations

### kexue.fm Anti-Bot Protection

**Issue**: kexue.fm has strict anti-bot protection that blocks automated requests.

**Behavior**:
- **Jina Strategy**: Returns HTTP 451 (Unavailable For Legal Reasons)
- **Direct Strategy**: Returns HTTP 403 (Forbidden)
- **Browserless Strategy**: May work with proper API key (requires JavaScript rendering)

**Solution**:
To fetch kexue.fm successfully, you need to:
1. Configure a Browserless API key in Obsidian settings
2. Use `strategy: 'auto'` or `strategy: 'browserless'`
3. The skill will automatically fallback to Browserless when Jina fails

**Testing with Browserless**:
```bash
BROWSERLESS_API_KEY=your_key_here npm test -- tests/skills/web-fetch/web-fetch.integration.test.ts
```

### arxiv.org

**Status**: ✅ Works well with both Direct and Jina strategies

**Behavior**:
- **Direct Strategy**: Successfully fetches HTML content (~86KB)
- **Jina Strategy**: Successfully fetches cleaned markdown content (~95KB)

## Running Tests

```bash
# Run all tests
npm test

# Run only unit tests (fast)
npm test -- tests/skills/web-fetch/web-fetch.test.ts

# Run only integration tests (slow, requires network)
npm test -- tests/skills/web-fetch/web-fetch.integration.test.ts

# Run with Browserless API key
BROWSERLESS_API_KEY=your_key npm test -- tests/skills/web-fetch/web-fetch.integration.test.ts
```

## Strategy Selection

The web-fetch skill supports three strategies:

1. **jina** (default): Uses Jina AI Reader for clean, markdown content
   - Best for: Articles, blog posts, documentation
   - Limitations: Some sites block Jina (returns 451)

2. **direct**: Direct HTTP request with browser-like headers
   - Best for: Simple HTML pages, APIs
   - Limitations: Sites with anti-bot protection may block (returns 403)

3. **browserless**: Uses Browserless API for JavaScript rendering
   - Best for: Sites requiring JavaScript, sites with anti-bot protection
   - Requirements: Browserless API key must be configured
   - Limitations: Slower, requires paid API

4. **auto** (recommended): Automatically tries strategies in order:
   - First: Jina (fast, clean content)
   - Fallback: Browserless (if API key available and Jina fails)
   - Fallback: Direct (if Browserless unavailable)

## Troubleshooting

### "All fetch strategies failed"

This error occurs when all attempted strategies fail. Common causes:

1. **No Browserless API key**: Configure in Obsidian settings for sites requiring JavaScript
2. **Network issues**: Check your internet connection
3. **Site blocking**: Some sites block all automated access
4. **Invalid URL**: Verify the URL is correct and accessible

### HTTP 403 Forbidden

The site is blocking automated requests. Solutions:
- Use Browserless strategy with API key
- Some sites cannot be accessed programmatically

### HTTP 451 Unavailable For Legal Reasons

Jina AI Reader cannot access this site. Solutions:
- Use `strategy: 'direct'` or `strategy: 'browserless'`
- Or use `strategy: 'auto'` to automatically fallback
