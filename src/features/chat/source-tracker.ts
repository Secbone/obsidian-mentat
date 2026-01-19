// Source Tracker - Tracks and formats citation sources from RAG results

import { FileChunk } from '../../indexing/chunk-processor';

export interface CitationSource {
  filePath: string;
  fileName: string;
  lineRange: { start: number; end: number };
  snippet: string;
  relevanceScore: number;
}

export class SourceTracker {
  /**
   * Extract citation sources from retrieved chunks
   */
  extractSources(chunks: FileChunk[]): CitationSource[] {
    return chunks.map(chunk => {
      const fileName = chunk.filePath.split('/').pop() || chunk.filePath;
      const snippet = chunk.content.substring(0, 150) + '...';

      return {
        filePath: chunk.filePath,
        fileName,
        lineRange: {
          start: chunk.metadata.startLine,
          end: chunk.metadata.endLine
        },
        snippet,
        relevanceScore: 0 // Will be populated from similarity search results
      };
    });
  }

  /**
   * Format sources as markdown for display
   */
  formatSourcesAsMarkdown(sources: CitationSource[]): string {
    if (sources.length === 0) return '';

    const lines = ['', '---', '**Sources:**', ''];

    sources.forEach((source, idx) => {
      const lineInfo = `lines ${source.lineRange.start}-${source.lineRange.end}`;
      lines.push(`${idx + 1}. [[${source.filePath}|${source.fileName}]] (${lineInfo})`);
    });

    return lines.join('\n');
  }
}
