// Content Extractor - Extracts content and metadata from Obsidian files

import { IPlatformAdapter, IPlatformFile, IFileCache } from '../types/platform';

export interface ExtractedContent {
  content: string;
  metadata: {
    tags: string[];
    links: string[];
    headings: string[];
    frontmatter: Record<string, unknown>;
  };
  stats: {
    wordCount: number;
    charCount: number;
    lastModified: number;
    created: number;
  };
}

export class ContentExtractor {
  constructor(
    private platform: IPlatformAdapter
  ) {}

  /**
   * Extract content and metadata from a file
   */
  async extract(file: IPlatformFile): Promise<ExtractedContent> {
    // Read file content
    const content = await this.platform.readFile(file);

    // Get cached metadata
    const metadata = this.platform.getFileCache(file);

    // Extract frontmatter
    const frontmatter = metadata?.frontmatter || {};

    // Extract tags (including frontmatter and inline tags)
    const tags = this.extractTags(content, metadata);

    // Extract links (from frontmatter/body)
    const links = this.extractLinks(metadata);

    // Extract headings
    const headings = this.extractHeadings(metadata);

    // Calculate statistics
    const stats = this.calculateStats(content, file);

    return {
      content,
      metadata: { tags, links, headings, frontmatter },
      stats
    };
  }

  /**
   * Extract tags from frontmatter and inline tags
   */
  private extractTags(content: string, metadata: IFileCache | null): string[] {
    const tags = new Set<string>();

    // Extract from frontmatter
    if (metadata?.frontmatter?.tags) {
      const fmTags = metadata.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        fmTags.forEach(tag => tags.add(String(tag)));
      } else if (typeof fmTags === 'string') {
        tags.add(fmTags);
      }
    }

    // Extract inline tags (#tag)
    if (metadata?.tags) {
      metadata.tags.forEach(tagCache => {
        tags.add(tagCache.tag.replace(/^#/, ''));
      });
    }

    return Array.from(tags);
  }

  /**
   * Extract internal links
   */
  private extractLinks(metadata: IFileCache | null): string[] {
    // Note: link extraction in Obsidian cache
    // We try to grab internal links. If platform doesn't parse it fully, we return empty or extract what we can.
    // In our mock, we assume metadata contains parsed links if they exist.
    const rawLinks = (metadata as unknown as { links?: Array<{ link?: string }> | string[] })?.links || [];
    return rawLinks.map((link: string | { link?: string }) => typeof link === 'string' ? link : (link.link || ''));
  }

  /**
   * Extract headings
   */
  private extractHeadings(metadata: IFileCache | null): string[] {
    const rawHeadings = (metadata as unknown as { headings?: Array<{ heading?: string }> | string[] })?.headings || [];
    return rawHeadings.map((h: string | { heading?: string }) => typeof h === 'string' ? h : (h.heading || ''));
  }

  /**
   * Calculate content statistics
   */
  private calculateStats(content: string, file: IPlatformFile) {
    return {
      wordCount: content.split(/\s+/).filter(w => w.length > 0).length,
      charCount: content.length,
      lastModified: file.stat.mtime,
      created: file.stat.ctime
    };
  }
}
