import { z } from 'zod';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';
import { requestUrl } from 'obsidian';

export const metadata = {
  name: 'web_search',
  description: 'Search the web and return relevant results with automatic engine selection and fallback',
  version: '1.0.0',
  tags: ['web', 'search', 'external'],
  executionCategory: 'external',
  permissions: ['read']
};

const InputSchema = z.object({
  query: z.string().min(1).describe('Search query'),
  limit: z.number().min(1).max(20).optional().default(10).describe('Number of results to return'),
  freshness: z.enum(['day', 'week', 'month', 'year']).optional().describe('Time range for results')
});

// Internal defaults for removed parameters
const COUNTRY = 'US';
const LANGUAGE = 'en';
const SAFE_SEARCH = 'moderate';

type Input = z.infer<typeof InputSchema>;

interface SearchResult {
  title: string;
  url: string;
  description: string;
  publishedDate?: string;
  thumbnail?: string;
}

interface SearchResponse {
  query: string;
  engine: string;
  results: SearchResult[];
  totalResults?: number;
  executionTime: number;
}

/**
 * Search using Brave Search API
 */
async function searchWithBrave(
  input: Input,
  apiKey: string
): Promise<{ success: boolean; data?: SearchResponse; error?: string }> {
  if (!apiKey) {
    return {
      success: false,
      error: 'Brave Search API key not configured'
    };
  }

  const startTime = Date.now();

  try {
    // Build query parameters
    const params = new URLSearchParams({
      q: input.query,
      count: input.limit.toString(),
      country: COUNTRY.toLowerCase(),
      search_lang: LANGUAGE,
      safesearch: SAFE_SEARCH
    });

    // Add freshness if specified
    if (input.freshness) {
      // Map our freshness values to Brave's format
      const freshnessMap: Record<string, string> = {
        'day': 'pd',    // past day
        'week': 'pw',   // past week
        'month': 'pm',  // past month
        'year': 'py'    // past year
      };
      params.append('freshness', freshnessMap[input.freshness] || '');
    }

    const url = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;

    const response = await requestUrl({
      url,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey
      },
      throw: false
    });

    if (response.status === 401) {
      return {
        success: false,
        error: 'Invalid Brave Search API key'
      };
    }

    if (response.status === 429) {
      return {
        success: false,
        error: 'Brave Search API rate limit exceeded'
      };
    }

    if (response.status !== 200) {
      return {
        success: false,
        error: `Brave Search API returned status ${response.status}`
      };
    }

    const data = response.json;

    // Parse Brave results
    const results: SearchResult[] = (data.web?.results || []).slice(0, input.limit).map((item: any) => ({
      title: item.title || '',
      url: item.url || '',
      description: item.description || '',
      publishedDate: item.age || item.published_date,
      thumbnail: item.thumbnail?.src
    }));

    const executionTime = Date.now() - startTime;

    return {
      success: true,
      data: {
        query: input.query,
        engine: 'brave',
        results,
        totalResults: data.web?.count,
        executionTime
      }
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Brave Search error: ${error.message}`
    };
  }
}

/**
 * Search using DuckDuckGo (HTML scraping as they don't have official API)
 */
async function searchWithDuckDuckGo(
  input: Input
): Promise<{ success: boolean; data?: SearchResponse; error?: string }> {
  const startTime = Date.now();

  try {
    // DuckDuckGo HTML search URL
    const params = new URLSearchParams({
      q: input.query,
      kl: `${COUNTRY.toLowerCase()}-${LANGUAGE}`, // Region setting
      kp: '-1' // moderate safe search
    });

    // Add time range if specified
    if (input.freshness) {
      const freshnessMap: Record<string, string> = {
        'day': 'd',
        'week': 'w',
        'month': 'm',
        'year': 'y'
      };
      params.append('df', freshnessMap[input.freshness] || '');
    }

    const url = `https://html.duckduckgo.com/html/?${params.toString()}`;

    const response = await requestUrl({
      url,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      throw: false
    });

    if (response.status !== 200) {
      return {
        success: false,
        error: `DuckDuckGo returned status ${response.status}`
      };
    }

    // Parse HTML response (basic extraction)
    const html = response.text;
    const results: SearchResult[] = [];

    // Try multiple patterns to extract results
    // Pattern 1: Standard DuckDuckGo result format
    const patterns = [
      // Pattern with result__a class
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]+)<\/a>/g,
      // Simplified pattern for testing
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]+)/g,
      // Pattern for h2 wrapped results
      /<h2[^>]*>.*?<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>.*?<\/h2>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]+)/g
    ];

    let match;
    let count = 0;
    let foundResults = false;

    for (const pattern of patterns) {
      if (foundResults) break;

      pattern.lastIndex = 0; // Reset regex
      while ((match = pattern.exec(html)) !== null && count < input.limit) {
        const url = match[1];
        const title = match[2].replace(/\s+/g, ' ').trim();
        const description = (match[3] || '').replace(/\s+/g, ' ').trim();

        // Clean up HTML entities
        const cleanTitle = title
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");

        const cleanDescription = description
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/<[^>]*>/g, ''); // Remove all HTML tags

        results.push({
          title: cleanTitle,
          url: url,
          description: cleanDescription
        });
        count++;
        foundResults = true;
      }
    }

    const executionTime = Date.now() - startTime;

    return {
      success: true,
      data: {
        query: input.query,
        engine: 'duckduckgo',
        results,
        executionTime
      }
    };
  } catch (error: any) {
    return {
      success: false,
      error: `DuckDuckGo error: ${error.message}`
    };
  }
}

/**
 * Main execution function
 */
async function execute(input: Input, context: SkillContext): Promise<SkillResult> {
  const startTime = Date.now();

  try {
    // Validate input
    if (!input.query || input.query.trim().length === 0) {
      return {
        success: false,
        error: 'Search query cannot be empty'
      };
    }

    // Get Brave API key from settings
    const braveApiKey = context.plugin.settings.braveSearchApiKey || '';

    // Perform search: Brave if API key available, otherwise DuckDuckGo
    let result;
    const errors: string[] = [];

    if (braveApiKey) {
      result = await searchWithBrave(input, braveApiKey);
      if (!result.success) {
        errors.push(`Brave: ${result.error}`);
        // Fallback to DuckDuckGo
        result = await searchWithDuckDuckGo(input);
        if (!result.success) {
          errors.push(`DuckDuckGo: ${result.error}`);
        }
      }
    } else {
      result = await searchWithDuckDuckGo(input);
      if (!result.success) {
        errors.push(`DuckDuckGo: ${result.error}`);
      }
    }

    // Check if we got results
    if (!result?.success || !result.data) {
      return {
        success: false,
        error: errors.length > 0 ? errors.join('; ') : 'Search failed',
        data: { errors }
      };
    }

    // Add total execution time
    const totalExecutionTime = Date.now() - startTime;

    return {
      success: true,
      data: {
        ...result.data,
        totalExecutionTime
      }
    };

  } catch (error: any) {
    return {
      success: false,
      error: `Search error: ${error.message}`,
      data: {
        executionTime: Date.now() - startTime
      }
    };
  }
}

export function createSkill(context: SkillContext) {
  return {
    schema: InputSchema,
    execute: (input: Input) => execute(input, context)
  };
}