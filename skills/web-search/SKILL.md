---
name: web_search
description: Search the web and return relevant results with automatic engine selection and fallback
metadata:
  version: "1.0.0"
  author: mentat
  tags: [web, search, external]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: false
  category: external-data
---

# Web Search Skill

Search the web and return relevant results. The skill automatically selects the best available search engine and falls back gracefully if needed.

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | Search query |
| `limit` | number | No | `10` | Number of results (1-20) |
| `freshness` | string | No | - | Time range: `"day"`, `"week"`, `"month"`, `"year"` |

## Output

Returns JSON with:
- `success`: boolean indicating if search succeeded
- `message`: Status message
- `data`: Object containing:
  - `query`: Original search query
  - `engine`: Search engine used
  - `results`: Array of search results
  - `totalResults`: Estimated total results (if available)
  - `executionTime`: Time taken in ms

Each result contains:
- `title`: Page title
- `url`: Page URL
- `description`: Snippet/summary
- `publishedDate`: Publication date (if available)
- `thumbnail`: Thumbnail URL (if available)

## Examples

### Basic Search
```json
{
  "query": "obsidian markdown editor"
}
```

### Search with Limit
```json
{
  "query": "typescript best practices",
  "limit": 15
}
```

### Recent Results
```json
{
  "query": "weather forecast",
  "freshness": "day"
}
```

## Configuration

### Brave Search API Key

To enable higher-quality search results:

1. Sign up at https://brave.com/search/api/
2. Get your API key from the dashboard
3. Add it to plugin settings: Settings → Personal Agent → Brave Search API Key

Without an API key, searches will automatically use DuckDuckGo.

## Error Handling

Common errors:
- **Invalid API key**: Check your Brave API key in settings
- **Rate limit exceeded**: Brave free tier limit reached (2000/month)
- **Network errors**: Check internet connection
- **No results found**: Try different search terms
- **Timeout**: Search took too long (>10s timeout)

## Best Practices

1. **Use specific queries** — More specific terms yield better results
2. **Set appropriate freshness** — Use `"day"` or `"week"` for news/current events
3. **Handle errors gracefully** — Always check the `success` field
4. **Respect rate limits** — Monitor Brave API usage in free tier

## Limitations

- Max 20 results per search
- Brave API: 2000 queries/month (free tier)
- No image/video search (text results only)
- No advanced operators (site:, filetype:, etc.)
- Results may vary by region/language
