// Chunk Processor - Splits documents into semantic chunks with overlap

import { TFile } from 'obsidian';
import { ExtractedContent } from './content-extractor';

export interface FileChunk {
  filePath: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  metadata: {
    startLine: number;
    endLine: number;
    heading?: string;
    tags: string[];
  };
}

export interface ChunkOptions {
  chunkSize: number;      // Characters per chunk (default: 1000)
  chunkOverlap: number;   // Overlapping characters (default: 200)
  respectBoundaries: boolean; // Respect paragraph boundaries (default: true)
}

export class ChunkProcessor {
  private defaultOptions: ChunkOptions = {
    chunkSize: 1000,
    chunkOverlap: 200,
    respectBoundaries: true
  };

  /**
   * Split a document into chunks
   */
  async chunkDocument(
    file: TFile,
    extractedContent: ExtractedContent,
    options?: Partial<ChunkOptions>
  ): Promise<Omit<FileChunk, 'embedding'>[]> {
    const opts = { ...this.defaultOptions, ...options };
    const { content, metadata } = extractedContent;

    // Split into paragraphs (respecting markdown structure)
    const paragraphs = this.splitIntoParagraphs(content);

    const chunks: Omit<FileChunk, 'embedding'>[] = [];
    let currentChunk = '';
    let currentStartLine = 0;
    let chunkIndex = 0;

    for (const para of paragraphs) {
      // Check if adding this paragraph would exceed chunk size
      if (currentChunk.length + para.length > opts.chunkSize && currentChunk.length > 0) {
        // Save current chunk
        chunks.push({
          filePath: file.path,
          chunkIndex: chunkIndex++,
          content: currentChunk.trim(),
          metadata: {
            startLine: currentStartLine,
            endLine: currentStartLine + currentChunk.split('\n').length,
            tags: metadata.tags
          }
        });

        // Start new chunk with overlap
        if (opts.chunkOverlap > 0) {
          const overlap = currentChunk.slice(-opts.chunkOverlap);
          currentChunk = overlap + '\n\n' + para;
        } else {
          currentChunk = para;
        }
        currentStartLine += currentChunk.split('\n').length;
      } else {
        // Add paragraph to current chunk
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      }
    }

    // Save last chunk
    if (currentChunk.trim()) {
      chunks.push({
        filePath: file.path,
        chunkIndex: chunkIndex++,
        content: currentChunk.trim(),
        metadata: {
          startLine: currentStartLine,
          endLine: currentStartLine + currentChunk.split('\n').length,
          tags: metadata.tags
        }
      });
    }

    return chunks;
  }

  /**
   * Split content into paragraphs
   */
  private splitIntoParagraphs(content: string): string[] {
    // Split by double newlines (paragraph boundaries)
    return content
      .split(/\n\n+/)
      .filter(p => p.trim().length > 0);
  }
}
