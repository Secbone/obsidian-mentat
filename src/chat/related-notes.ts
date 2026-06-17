// Related Notes Recommender - Suggests related notes based on conversation context

import { TFile } from 'obsidian';
import MentatPlugin from '../main';
import { IndexManager } from '../indexing/index-manager';

export interface RelatedNote {
  file: TFile;
  score: number;
  reason: string;
}

export class RelatedNotesRecommender {
  constructor(
    private plugin: MentatPlugin,
    private indexManager: IndexManager
  ) {}

  /**
   * Recommend related notes based on conversation context
   */
  async recommend(
    conversationContext: string,
    excludeFiles: string[],
    limit: number = 3
  ): Promise<RelatedNote[]> {
    // Extract keywords from conversation
    const keywords = this.extractKeywords(conversationContext);

    // Search for related documents
    const results = await this.indexManager.search(keywords, {
      topK: limit + excludeFiles.length,
      minScore: 0.4
    });

    // Filter out already selected documents
    const filtered = results
      .filter(r => !excludeFiles.includes(r.chunk.filePath))
      .slice(0, limit);

    // Convert to RelatedNote format
    const notes: RelatedNote[] = [];

    for (const result of filtered) {
      const file = this.plugin.app.vault.getAbstractFileByPath(result.chunk.filePath);
      if (file instanceof TFile) {
        notes.push({
          file,
          score: result.score,
          reason: this.generateReason(result.chunk.content, keywords)
        });
      }
    }

    return notes;
  }

  /**
   * Extract keywords from conversation text
   */
  private extractKeywords(text: string): string {
    // Simple keyword extraction (can be enhanced with TF-IDF or NLP)
    const words = text.toLowerCase().split(/\s+/);
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'how', 'why',
      'when', 'where', 'who', 'which', 'this', 'that', 'these', 'those',
      'can', 'could', 'would', 'should', 'will', 'do', 'does', 'did'
    ]);

    const filtered = words
      .filter(w => w.length > 3 && !stopWords.has(w))
      .slice(0, 10);

    return filtered.join(' ');
  }

  /**
   * Generate a reason for why this note is relevant
   */
  private generateReason(content: string, keywords: string): string {
    // Find the first sentence containing a keyword
    const sentences = content.split(/[.!?]+/);
    const keywordList = keywords.toLowerCase().split(/\s+/);

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      if (keywordList.some(kw => lower.includes(kw))) {
        return sentence.trim().substring(0, 100) + '...';
      }
    }

    return content.substring(0, 100) + '...';
  }
}
