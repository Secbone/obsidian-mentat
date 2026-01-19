// Personal Agent Settings Interface
export interface PersonalAgentSettings {
  // AI Providers Configuration
  aiProviders: AIProviderConfig[];
  defaultProvider: string; // Provider ID for default tasks

  // Task-specific routing
  taskRouting: {
    embedding: string;     // Provider ID for embedding tasks
    classification: string; // Provider ID for classification
    linking: string;       // Provider ID for link suggestions
    chat: string;          // Provider ID for chat
    review: string;        // Provider ID for review
  };

  // OpenCode Integration (Optional)
  opencodeEnabled: boolean;
  opencodeApiUrl: string;
  opencodeApiKey: string;

  // Feature Toggles
  autoClassificationEnabled: boolean;
  linkSuggestionEnabled: boolean;
  chatEnabled: boolean;
  graphEnabled: boolean;
  reviewEnabled: boolean;

  // Performance Configuration
  indexingBatchSize: number;  // Default 50
  cacheExpiryDays: number;     // Default 7
  maxEmbeddingCache: number;   // Default 1000

  // Review Configuration
  reviewIntervalDays: number;  // Default 7
  enableSpacedRepetition: boolean;
}

export interface AIProviderConfig {
  id: string;                  // Unique identifier
  name: string;                // Display name
  type: 'openai' | 'anthropic' | 'ollama';
  enabled: boolean;

  // Connection details
  apiKey?: string;
  baseURL?: string;

  // Model configuration
  model: string;
  embeddingModel?: string;

  // Capabilities
  supportsEmbedding: boolean;
  supportsStreaming: boolean;

  // Advanced options
  temperature?: number;
  maxTokens?: number;
}

export const DEFAULT_SETTINGS: PersonalAgentSettings = {
  aiProviders: [],
  defaultProvider: '',

  taskRouting: {
    embedding: '',
    classification: '',
    linking: '',
    chat: '',
    review: ''
  },

  opencodeEnabled: false,
  opencodeApiUrl: '',
  opencodeApiKey: '',

  autoClassificationEnabled: true,
  linkSuggestionEnabled: true,
  chatEnabled: true,
  graphEnabled: true,
  reviewEnabled: true,

  indexingBatchSize: 50,
  cacheExpiryDays: 7,
  maxEmbeddingCache: 1000,

  reviewIntervalDays: 7,
  enableSpacedRepetition: true
};
