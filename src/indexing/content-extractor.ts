// Content Extractor - Extracts content and metadata from Obsidian files

import { App, TFile, MetadataCache, CachedMetadata } from 'obsidian';

export interface ExtractedContent {
  content: string;
  metadata: {
    tags: string[];
    links: string[];
    headings: string[];
    frontmatter: Record<string, any>;
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
    private app: App,
    private metadataCache: MetadataCache
  ) {}

  /**
   * Extract content and metadata from a file
   */
  async extract(file: TFile): Promise<ExtractedContent> {
    // Read file content
    const content = await this.app.vault.read(file);

    // Get cached metadata
    const metadata = this.metadataCache.getFileCache(file);

    // Extract frontmatter
    const frontmatter = metadata?.frontmatter || {};

    // Extract tags (including frontmatter and inline tags)
    const tags = this.extractTags(content, metadata);

    // Extract links
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
  private extractTags(content: string, metadata: CachedMetadata | null): string[] {
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
  private extractLinks(metadata: CachedMetadata | null): string[] {
    if (!metadata?.links) return [];
    return metadata.links.map(link => link.link);
  }

  /**
   * Extract headings
   */
  private extractHeadings(metadata: CachedMetadata | null): string[] {
    if (!metadata?.headings) return [];
    return metadata.headings.map(h => h.heading);
  }

  /**
   * Calculate content statistics
   */
  private calculateStats(content: string, file: TFile) {
    return {
      wordCount: content.split(/\s+/).filter(w => w.length > 0).length,
      charCount: content.length,
      lastModified: file.stat.mtime,
      created: file.stat.ctime
    };
  }
}
