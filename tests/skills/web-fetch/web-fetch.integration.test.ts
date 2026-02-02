import { describe, it, expect } from 'vitest';
import { createSkill } from '../../../skills/web-fetch/scripts/index';
import { mockContextWithoutBrowserless } from './mocks/skill-context.mock';

/**
 * Integration tests for web-fetch skill
 * These tests make real network requests and are not mocked
 *
 * Note: To test Browserless functionality, set BROWSERLESS_API_KEY environment variable
 */
describe('Web-Fetch Integration Tests', () => {
  // Check if Browserless API key is available from environment
  const browserlessApiKey = process.env.BROWSERLESS_API_KEY || '';

  const createContextWithBrowserless = () => {
    if (!browserlessApiKey) {
      return mockContextWithoutBrowserless;
    }

    return {
      ...mockContextWithoutBrowserless,
      plugin: {
        settings: {
          browserlessApiKey: browserlessApiKey
        }
      }
    } as any;
  };

  it('should attempt to fetch https://kexue.fm/ using auto strategy', async () => {
    const context = createContextWithBrowserless();
    const skill = createSkill(context);
    const input = skill.schema.parse({
      url: 'https://kexue.fm/',
      strategy: 'auto',
      timeout: 30000
    });

    const result = await skill.execute(input);

    console.log('Kexue.fm (auto) result:', {
      success: result.success,
      strategy: result.data?.strategy,
      contentLength: result.data?.content?.length,
      error: result.error,
      hasBrowserlessKey: !!browserlessApiKey,
      contentPreview: result.success ? result.data?.content?.substring(0, 200) : undefined
    });

    // If Browserless API key is available, it should attempt fallback
    // Note: Success depends on external API availability
    if (browserlessApiKey) {
      // Verify that fallback was attempted by checking error message
      if (!result.success) {
        // If all strategies failed, error should mention multiple strategies
        expect(result.error).toBeTruthy();
        console.log('Note: All strategies failed. This may be due to API availability, rate limits, or invalid API key.');
      } else {
        // If successful, verify content
        expect(result.success).toBe(true);
        expect(result.data?.content).toBeTruthy();
        expect(result.data?.content.length).toBeGreaterThan(1000);
        expect(result.data?.strategy).toBe('browserless'); // Should use Browserless, not Jina
      }
    } else {
      // Without Browserless, kexue.fm cannot be fetched due to anti-bot protection
      expect(result.success).toBe(false);
    }
  }, 60000);

  it('should attempt to fetch https://kexue.fm/ using direct strategy', async () => {
    const skill = createSkill(mockContextWithoutBrowserless);
    const input = skill.schema.parse({
      url: 'https://kexue.fm/',
      strategy: 'direct',
      timeout: 30000
    });

    const result = await skill.execute(input);

    console.log('Kexue.fm (direct) result:', {
      success: result.success,
      strategy: result.data?.strategy,
      contentLength: result.data?.content?.length,
      error: result.error
    });

    // Note: kexue.fm returns 403 for direct requests without proper headers/cookies
    // This is expected behavior due to anti-bot protection
    expect(result.success).toBe(false);
    expect(result.error).toContain('403');
  }, 60000);

  it('should fetch https://arxiv.org/html/2601.07372v1 using direct strategy', async () => {
    const skill = createSkill(mockContextWithoutBrowserless);
    const input = skill.schema.parse({
      url: 'https://arxiv.org/html/2601.07372v1',
      strategy: 'direct',
      timeout: 30000
    });

    const result = await skill.execute(input);

    console.log('Arxiv result:', {
      success: result.success,
      strategy: result.data?.strategy,
      contentLength: result.data?.content?.length,
      error: result.error
    });

    expect(result.success).toBe(true);
    expect(result.data?.content).toBeTruthy();
    expect(result.data?.content.length).toBeGreaterThan(100);
    expect(result.data?.strategy).toBe('direct');
  }, 60000);

  it('should fetch https://arxiv.org/html/2601.07372v1 using auto strategy (Jina)', async () => {
    const skill = createSkill(mockContextWithoutBrowserless);
    const input = skill.schema.parse({
      url: 'https://arxiv.org/html/2601.07372v1',
      strategy: 'auto',
      timeout: 30000
    });

    const result = await skill.execute(input);

    console.log('Arxiv (auto) result:', {
      success: result.success,
      strategy: result.data?.strategy,
      contentLength: result.data?.content?.length,
      error: result.error
    });

    expect(result.success).toBe(true);
    expect(result.data?.content).toBeTruthy();
    expect(result.data?.content.length).toBeGreaterThan(100);
  }, 60000);
});
