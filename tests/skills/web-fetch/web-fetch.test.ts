import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSkill, metadata } from '../../../skills/web-fetch/scripts/index';
import { mockContextWithBrowserless, mockContextWithoutBrowserless } from './mocks/skill-context.mock';
import { requestUrl } from 'obsidian';

describe('Web-Fetch Skill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Test Case 1: Successful fetch of https://kexue.fm', () => {
    it('should successfully fetch content from kexue.fm using Jina', async () => {
      // Mock successful Jina response
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        text: '# 科学空间\n\nTest content from kexue.fm',
        headers: { 'content-type': 'text/plain' },
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      const skill = createSkill(mockContextWithoutBrowserless);
      const input = skill.schema.parse({
        url: 'https://kexue.fm',
        strategy: 'auto',
        timeout: 30000
      });

      const result = await skill.execute(input);

      expect(result.success).toBe(true);
      expect(result.data?.content).toContain('科学空间');
      expect(result.data?.strategy).toBe('jina');
      expect(requestUrl).toHaveBeenCalledTimes(1);
      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://r.jina.ai/https://kexue.fm',
          method: 'GET'
        })
      );
    });

    it('should return metadata with execution time', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        text: 'Test content',
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      const skill = createSkill(mockContextWithoutBrowserless);
      const input = skill.schema.parse({
        url: 'https://kexue.fm',
        strategy: 'auto'
      });

      const result = await skill.execute(input);

      expect(result.success).toBe(true);
      expect(result.data?.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Test Case 2: Fallback when Jina returns 403', () => {
    it('should fallback to browserless when Jina returns warning', async () => {
      // Mock Jina returning warning
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        text: 'Warning: Target URL returned error 403: Forbidden\n',
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      // Mock Browserless success
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        text: '<html><body>Real content from Browserless</body></html>',
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      const skill = createSkill(mockContextWithBrowserless);
      const input = skill.schema.parse({
        url: 'https://example.com',
        strategy: 'auto'
      });

      const result = await skill.execute(input);

      expect(result.success).toBe(true);
      expect(result.data?.strategy).toBe('browserless');
      expect(result.data?.content).toContain('Real content');
      expect(requestUrl).toHaveBeenCalledTimes(2); // Jina + Browserless
    });

    it('should fallback to Browserless when Jina returns 403 with auto strategy', async () => {
      // Mock Jina returning 403
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 403,
        text: 'Forbidden',
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      // Mock Browserless success
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        text: '<html><body>Content from Browserless</body></html>',
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      const skill = createSkill(mockContextWithBrowserless);
      const input = skill.schema.parse({
        url: 'https://kexue.fm',
        strategy: 'auto',
        timeout: 30000
      });

      const result = await skill.execute(input);

      // Should fallback to Browserless when Jina fails
      expect(result.success).toBe(true);
      expect(result.data?.strategy).toBe('browserless');
      expect(requestUrl).toHaveBeenCalledTimes(2); // Jina + Browserless
    });

    it('should NOT fallback to Browserless when Jina times out', async () => {
      // Mock Jina timeout error
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'TimeoutError';

      vi.mocked(requestUrl).mockRejectedValueOnce(timeoutError);

      const skill = createSkill(mockContextWithBrowserless);
      const input = skill.schema.parse({
        url: 'https://kexue.fm',
        strategy: 'jina',
        timeout: 1000
      });

      const result = await skill.execute(input);

      expect(result.success).toBe(false);
      expect(result.error).toContain('failed');

      // Verify only Jina was called (no fallback on timeout)
      expect(requestUrl).toHaveBeenCalledTimes(1);
    });

    it('should fail when Jina returns 403 and no Browserless API key configured', async () => {
      // Mock Jina returning 403
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 403,
        text: 'Forbidden',
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      const skill = createSkill(mockContextWithoutBrowserless);
      const input = skill.schema.parse({
        url: 'https://kexue.fm',
        strategy: 'jina'
      });

      const result = await skill.execute(input);

      expect(result.success).toBe(false);
      expect(result.error).toContain('failed');

      // Should only try Jina when strategy is explicitly 'jina'
      expect(requestUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe('Additional Edge Cases', () => {
    it('should handle network errors with fallback', async () => {
      const networkError = new Error('Network connection failed');

      vi.mocked(requestUrl).mockRejectedValueOnce(networkError);

      const skill = createSkill(mockContextWithBrowserless);
      const input = skill.schema.parse({
        url: 'https://kexue.fm',
        strategy: 'jina'
      });

      const result = await skill.execute(input);

      // Network errors should cause failure without fallback when using specific strategy
      expect(result.success).toBe(false);
      expect(requestUrl).toHaveBeenCalledTimes(1);
    });

    it('should validate input schema', () => {
      const skill = createSkill(mockContextWithoutBrowserless);

      expect(() => {
        skill.schema.parse({
          url: 'not-a-valid-url'
        });
      }).toThrow();
    });

    it('should block private IP addresses', async () => {
      const skill = createSkill(mockContextWithoutBrowserless);
      const input = skill.schema.parse({
        url: 'http://192.168.1.1',
        strategy: 'auto'
      });

      const result = await skill.execute(input);

      expect(result.success).toBe(false);
      expect(result.error).toContain('private');
    });

    it('should block localhost', async () => {
      const skill = createSkill(mockContextWithoutBrowserless);
      const input = skill.schema.parse({
        url: 'http://localhost:3000',
        strategy: 'auto'
      });

      const result = await skill.execute(input);

      expect(result.success).toBe(false);
      expect(result.error).toContain('private');
    });

    it('should handle JSON content type', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        text: '{"message": "Hello World"}',
        headers: { 'content-type': 'application/json' },
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      const skill = createSkill(mockContextWithoutBrowserless);
      const input = skill.schema.parse({
        url: 'https://r.jina.ai/https://api.example.com/data',
        strategy: 'jina',
        format: 'auto'
      });

      const result = await skill.execute(input);

      expect(result.success).toBe(true);
      expect(result.data?.content).toContain('Hello World');
    });

    it('should respect max response size limit', async () => {
      const largeContent = 'x'.repeat(6 * 1024 * 1024); // 6MB

      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        text: largeContent,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      const skill = createSkill(mockContextWithoutBrowserless);
      const input = skill.schema.parse({
        url: 'https://example.com',
        strategy: 'jina',
        maxResponseSize: 5242880 // 5MB default
      });

      const result = await skill.execute(input);

      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds limit');
    });
  });

  describe('Metadata', () => {
    it('should have correct metadata', () => {
      expect(metadata.name).toBe('web_fetch');
      expect(metadata.version).toBe('3.0.0');
      expect(metadata.tags).toContain('web');
    });
  });

  describe('Reproduce arxiv issue', () => {
    it('should fetch arxiv HTML page using direct strategy', async () => {
      // Mock direct fetch response
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        text: '<html><body><h1>Test arxiv content</h1></body></html>',
        headers: { 'content-type': 'text/html' },
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      const skill = createSkill(mockContextWithoutBrowserless);
      const input = skill.schema.parse({
        url: 'https://arxiv.org/html/2601.07372v1',
        strategy: 'direct',
        timeout: 30000
      });

      const result = await skill.execute(input);

      console.log('Result:', JSON.stringify(result, null, 2));

      expect(result.success).toBe(true);
      expect(result.data?.strategy).toBe('direct');
    }, 60000); // 60 second timeout for this test

    it('should handle malformed JSON when format is json', async () => {
      // Mock response with malformed JSON
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        text: '{"incomplete": "string',  // Unterminated string
        headers: { 'content-type': 'application/json' },
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      const skill = createSkill(mockContextWithoutBrowserless);
      const input = skill.schema.parse({
        url: 'https://example.com/api/data',
        strategy: 'direct',
        format: 'json',
        timeout: 30000
      });

      const result = await skill.execute(input);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to parse response as JSON');
    });

    it('should fetch kexue.fm using auto strategy', async () => {
      // Mock successful Jina response for kexue.fm
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        text: '# 科学空间\n\n这是一个测试内容，用于验证 kexue.fm 可以被正确获取。\n\n## 文章列表\n\n- 文章1\n- 文章2',
        headers: { 'content-type': 'text/plain' },
        arrayBuffer: new ArrayBuffer(0),
        json: {}
      });

      const skill = createSkill(mockContextWithoutBrowserless);
      const input = skill.schema.parse({
        url: 'https://kexue.fm/',
        strategy: 'auto',
        timeout: 30000
      });

      const result = await skill.execute(input);

      console.log('Kexue.fm fetch result:', JSON.stringify({
        success: result.success,
        strategy: result.data?.strategy,
        contentLength: result.data?.content?.length,
        error: result.error
      }, null, 2));

      expect(result.success).toBe(true);
      expect(result.data?.content).toContain('科学空间');
      expect(result.data?.strategy).toBe('jina');
    }, 60000);
  });
});
