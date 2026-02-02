import { z } from 'zod';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';
import TurndownService from 'turndown';
import { requestUrl } from 'obsidian';

export const metadata = {
  name: 'web_fetch',
  description: 'Fetch content from web URLs using multiple strategies: Jina AI Reader for clean content extraction, Browserless for JavaScript-rendered pages, or direct HTTP requests.',
  version: '3.0.0',
  tags: ['web', 'http', 'fetch', 'network', 'scraping']
};

const InputSchema = z.object({
  url: z.string().url().describe('The URL to fetch (http/https only)'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional().default('GET').describe('HTTP method'),
  headers: z.record(z.string()).optional().describe('Custom HTTP headers'),
  body: z.string().optional().describe('Request body for POST/PUT/PATCH requests'),
  timeout: z.number().min(1000).max(60000).optional().default(30000).describe('Timeout in milliseconds (1-60s)'),
  format: z.enum(['auto', 'markdown', 'json', 'text', 'raw']).optional().default('auto').describe('Output format (auto-detects if unspecified)'),
  maxResponseSize: z.number().min(1024).max(10485760).optional().default(5242880).describe('Max response size in bytes (default 5MB, max 10MB)'),
  strategy: z.enum(['auto', 'jina', 'browserless', 'direct']).optional().default('auto').describe('Fetching strategy: auto (try all), jina (Jina AI Reader), browserless (Browserless API), direct (HTTP request)'),
  useJavaScript: z.boolean().optional().default(false).describe('Whether the page requires JavaScript rendering (uses Browserless if true)')
});

type Input = z.infer<typeof InputSchema>;

// Helper to check for private IP ranges (SSRF protection)
function isPrivateIP(hostname: string): boolean {
  if (hostname === 'localhost') return true;

  const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = hostname.match(ipv4Pattern);

  if (match) {
    const parts = match.slice(1).map(Number);
    if (parts.some(p => p > 255)) return false;

    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
  }

  return false;
}

function convertHtmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    hr: '---'
  });

  turndownService.remove('script');
  turndownService.remove('style');

  return turndownService.turndown(html);
}

// FetchResult type with timeout flag
type FetchResult = {
  success: boolean;
  content?: string;
  error?: string;
  metadata?: any;
  isTimeout?: boolean;
};

// Strategy 1: Jina AI Reader
async function fetchWithJina(url: string, timeout: number): Promise<FetchResult> {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await requestUrl({
      url: jinaUrl,
      method: 'GET',
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown'
      },
      throw: false
    });

    if (response.status >= 200 && response.status < 300) {
      // Check if Jina returned a warning/error page
      const content = response.text;
      const hasWarning = content.includes('Warning:') &&
        (content.includes('Target URL returned error') ||
          content.includes('not yet fully loaded'));

      // If content is very short and contains warnings, treat as failure
      if (hasWarning && content.length < 500) {
        return {
          success: false,
          error: `Jina AI returned warning: ${content.split('\n')[0]}`,
          isTimeout: false
        };
      }

      return {
        success: true,
        content: response.text,
        metadata: {
          strategy: 'jina',
          status: response.status,
          headers: response.headers
        }
      };
    }

    // HTTP errors (403, 404, 500, etc.) - NOT timeouts, WILL trigger fallback
    return {
      success: false,
      error: `Jina AI returned status ${response.status}`,
      isTimeout: false
    };
  } catch (error: any) {
    // Detect timeout errors - these will NOT trigger fallback
    const isTimeout = error.message?.toLowerCase().includes('timeout') ||
                     error.name === 'TimeoutError' ||
                     error.code === 'ETIMEDOUT';

    return {
      success: false,
      error: `Jina AI error: ${error.message}`,
      isTimeout: isTimeout
    };
  }
}

// Strategy 2: Browserless API
async function fetchWithBrowserless(url: string, apiKey: string, timeout: number): Promise<FetchResult> {
  if (!apiKey) {
    return {
      success: false,
      error: 'Browserless API key not configured',
      isTimeout: false
    };
  }

  try {
    const browserlessUrl = `https://chrome.browserless.io/content?token=${apiKey}`;
    const response = await requestUrl({
      url: browserlessUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: url
      }),
      throw: false
    });

    if (response.status >= 200 && response.status < 300) {
      return {
        success: true,
        content: response.text,
        metadata: {
          strategy: 'browserless',
          status: response.status,
          headers: response.headers
        }
      };
    }

    return {
      success: false,
      error: `Browserless returned status ${response.status}`,
      isTimeout: false
    };
  } catch (error: any) {
    const isTimeout = error.message?.toLowerCase().includes('timeout') ||
                     error.name === 'TimeoutError' ||
                     error.code === 'ETIMEDOUT';

    return {
      success: false,
      error: `Browserless error: ${error.message}`,
      isTimeout: isTimeout
    };
  }
}

// Strategy 3: Direct HTTP Request
async function fetchDirect(input: Input): Promise<FetchResult> {
  try {
    const requestHeaders: Record<string, string> = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN,zh;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      ...input.headers
    };

    const response = await requestUrl({
      url: input.url,
      method: input.method || 'GET',
      headers: requestHeaders,
      body: input.body,
      throw: false
    });

    if (response.status >= 200 && response.status < 300) {
      return {
        success: true,
        content: response.text,
        metadata: {
          strategy: 'direct',
          status: response.status,
          statusText: response.status.toString(),
          headers: response.headers,
          contentType: response.headers['content-type'] || ''
        }
      };
    }

    return {
      success: false,
      error: `HTTP Error ${response.status}`,
      metadata: {
        status: response.status,
        headers: response.headers,
        body: response.text.slice(0, 500)
      },
      isTimeout: false
    };
  } catch (error: any) {
    const isTimeout = error.message?.toLowerCase().includes('timeout') ||
                     error.name === 'TimeoutError' ||
                     error.code === 'ETIMEDOUT';

    return {
      success: false,
      error: `Direct fetch error: ${error.message}`,
      isTimeout: isTimeout
    };
  }
}

async function execute(input: Input, context: SkillContext): Promise<SkillResult> {
  const startTime = Date.now();

  try {
    const parsedUrl = new URL(input.url);

    // 1. Validation & Security
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        success: false,
        error: `Unsupported protocol: ${parsedUrl.protocol}. Only http: and https: are supported.`
      };
    }

    if (isPrivateIP(parsedUrl.hostname)) {
      return {
        success: false,
        error: `Access to private/local network address '${parsedUrl.hostname}' is blocked for security.`
      };
    }

    // 2. Determine strategy
    const originalStrategy = input.strategy; // Preserve original for fallback logic
    let strategy = input.strategy;
    if (strategy === 'auto') {
      // If JavaScript is needed, prefer browserless
      if (input.useJavaScript) {
        strategy = 'browserless';
      } else {
        strategy = 'jina'; // Default to Jina for clean content
      }
    }

    // 3. Try fetching with selected strategy
    let result: FetchResult | null = null;
    const errors: string[] = [];

    // Get browserless API key from settings
    const browserlessApiKey = context.plugin.settings.browserlessApiKey || '';

    if (strategy === 'jina' || (strategy === 'auto' && !input.useJavaScript)) {
      result = await fetchWithJina(input.url, input.timeout);
      if (!result.success) {
        errors.push(`Jina: ${result.error}`);
      }
    }

    // Fallback to browserless ONLY if jina failed with non-timeout error
    if (!result?.success &&
        !result?.isTimeout &&
        (strategy === 'browserless' || originalStrategy === 'auto')) {
      result = await fetchWithBrowserless(input.url, browserlessApiKey, input.timeout);
      if (!result.success) {
        errors.push(`Browserless: ${result.error}`);
      }
    }

    // Fallback to direct if previous strategies failed (also skip on timeout)
    if (!result?.success &&
        !result?.isTimeout &&
        (strategy === 'direct' || originalStrategy === 'auto')) {
      result = await fetchDirect(input);
      if (!result.success) {
        errors.push(`Direct: ${result.error}`);
      }
    }

    // 4. Check if we got content
    if (!result?.success || !result.content) {
      return {
        success: false,
        error: `All fetch strategies failed: ${errors.join('; ')}`,
        data: { errors }
      };
    }

    // 5. Response Size Check
    if (result.content.length > input.maxResponseSize) {
      return {
        success: false,
        error: `Response body size (${result.content.length} bytes) exceeds limit of ${input.maxResponseSize} bytes.`
      };
    }

    // 6. Content Processing
    const contentType = result.metadata?.contentType || '';
    let resultFormat = input.format;

    // Auto-detect format
    if (resultFormat === 'auto') {
      if (contentType.includes('application/json')) {
        resultFormat = 'json';
      } else if (contentType.includes('text/html') || result.metadata?.strategy === 'browserless') {
        resultFormat = 'markdown';
      } else if (result.metadata?.strategy === 'jina') {
        resultFormat = 'markdown'; // Jina already returns markdown
      } else {
        resultFormat = 'text';
      }
    }

    let processedContent: any = result.content;

    try {
      if (resultFormat === 'json') {
        const parsed = JSON.parse(result.content);
        processedContent = JSON.stringify(parsed, null, 2);
      } else if (resultFormat === 'markdown') {
        // If content is HTML, convert to markdown
        if (result.metadata?.strategy !== 'jina' && result.content.includes('<html')) {
          processedContent = convertHtmlToMarkdown(result.content);
        }
        // Otherwise, content is already markdown (from Jina) or plain text
      }
    } catch (err: any) {
      if (input.format === 'json') {
        return {
          success: false,
          error: `Failed to parse response as JSON: ${err.message}`,
          data: { raw: result.content.slice(0, 500) }
        };
      }
      // For other formats, just use the raw content
    }

    const duration = Date.now() - startTime;

    return {
      success: true,
      message: `Successfully fetched ${input.url} using ${result.metadata?.strategy} strategy`,
      data: {
        url: input.url,
        status: result.metadata?.status || 200,
        headers: result.metadata?.headers || {},
        content: processedContent,
        contentType,
        contentLength: result.content.length,
        strategy: result.metadata?.strategy,
        executionTime: duration
      }
    };

  } catch (error: any) {
    const duration = Date.now() - startTime;

    return {
      success: false,
      error: error.message,
      data: { duration }
    };
  }
}

export function createSkill(context: SkillContext) {
  return {
    schema: InputSchema,
    execute: (input: Input) => execute(input, context)
  };
}
