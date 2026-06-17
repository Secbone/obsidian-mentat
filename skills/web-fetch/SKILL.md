---
name: web_fetch
description: Fetch content from web URLs using multiple strategies - Jina AI Reader for clean content extraction, Browserless for JavaScript-rendered pages, or direct HTTP requests.
metadata:
  version: "3.0.0"
  author: mentat
  tags: [web, http, fetch, network, scraping, external]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: false
  category: external-data
---

# Web Fetch Skill

Fetch content from web URLs using multiple intelligent strategies. Automatically selects the best method for fetching content based on your needs.

## Fetching Strategies

- **Jina AI Reader** (default): Clean content extraction from articles and web pages. Returns markdown, no ads/clutter, fast and free. May not work for all sites.
- **Browserless API** (optional): Full browser rendering for JavaScript-heavy sites. Requires paid API key, slower but handles dynamic content.
- **Direct HTTP** (fallback): Simple HTTP requests for APIs and static pages. Fast, supports all HTTP methods, but cannot render JavaScript.

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | URL to fetch (HTTP/HTTPS only) |
| `method` | string | No | `"GET"` | HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD) |
| `headers` | object | No | `{}` | Custom HTTP headers |
| `body` | string | No | - | Request body (for POST/PUT/PATCH) |
| `timeout` | number | No | `30000` | Timeout in ms (1000-60000) |
| `format` | string | No | `"auto"` | `"auto"`, `"markdown"`, `"json"`, `"text"`, or `"raw"` |
| `maxResponseSize` | number | No | `5242880` | Max response size in bytes (1KB-10MB) |
| `useJavaScript` | boolean | No | `false` | Prefer Browserless for JS-heavy sites |

## Output

Returns JSON with `success` (boolean), `message` (string), `data` (url, status, headers, content, contentType, contentLength, strategy, executionTime), and `error` (if failed).

## Security

Blocks local/private IPs (127.0.0.1, 192.168.x.x, 10.x.x.x, localhost, 169.254.x.x, etc.) to prevent SSRF attacks. Enforces timeouts (1-60s) and limits response size (max 10MB) to prevent resource exhaustion.

## Examples

### Basic fetch
```json
{
  "url": "https://example.com/article",
  "format": "markdown"
}
```

### JavaScript-heavy site (Browserless)
```json
{
  "url": "https://spa-app.com",
  "useJavaScript": true
}
```

### POST request with authentication
```json
{
  "url": "https://api.example.com/endpoint",
  "method": "POST",
  "headers": {"Content-Type": "application/json", "Authorization": "Bearer TOKEN"},
  "body": "{\"key\": \"value\"}"
}
```

## Configuration

### Browserless API Key (Optional)

To use the Browserless strategy for JavaScript-rendered pages:

1. Sign up at https://www.browserless.io/
2. Get your API key
3. Add it to plugin settings: Settings → Personal Agent → Browserless API Key

Without an API key, the skill will skip the Browserless strategy and fall back to direct HTTP requests.

## Performance

- **Jina AI**: Fast (~1-2s), free, best for articles/docs
- **Browserless**: Moderate (~3-5s), paid, best for JavaScript/SPAs
- **Direct**: Very fast (~0.5-1s), free, best for APIs/static pages

## Error Handling

Common errors: network failures, timeouts, HTTP errors (non-2xx), response too large, invalid JSON, blocked URLs (SSRF), or all strategies failed.

## Best Practices

1. **Enable useJavaScript for SPAs** - Set `useJavaScript: true` for React/Vue/Angular apps
2. **Handle errors gracefully** - Always check the success field before processing data

## Limitations

- Binary content (images, PDFs) not fully supported
- Max response size: 10MB, max timeout: 60s
- Only HTTP/HTTPS protocols supported
- Jina AI may not work for all sites
- Browserless requires paid API key
- No OAuth flows or complex authentication
