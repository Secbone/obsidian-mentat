// Personal Agent Settings Interface
import { MCPServerConfig } from '../skills/mcp/mcp-types';
import { SkillInvocationConfig } from '../types';
import { ContextOptions } from '../context/context-types';

export interface MentatSettings {
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

  // Web Fetch Configuration
  browserlessApiKey: string;

  // Web Search Configuration
  braveSearchApiKey: string;

  // Feature Toggles
  autoClassificationEnabled: boolean;
  linkSuggestionEnabled: boolean;
  chatEnabled: boolean;
  graphEnabled: boolean;
  reviewEnabled: boolean;

  // Skill System Configuration
  skillsEnabled: boolean;
  requireSkillConfirmation: boolean;
  allowedSkills: string[]; // List of allowed skill names (empty = all allowed)
  maxTurns: number; // Maximum agent loop iterations for skill execution

  // Skill Invocation Configuration (Progressive Disclosure)
  skillInvocationMode: 'progressive' | 'native' | 'auto';
  skillInvocationConfig?: SkillInvocationConfig;

  // MCP Configuration
  mcpServers: MCPServerConfig[];
  mcpTimeout: number;
  mcpRetryAttempts: number;

  // Context Manager Configuration
  contextManager?: {
    defaultStrategy: 'sliding-window' | 'token-limit' | 'relevance';
    llmDefaults?: ContextOptions;
    displayDefaults?: ContextOptions;
    enableCache?: boolean;
    cacheTTL?: number; // Cache time-to-live in milliseconds
  };

  // Performance Configuration
  indexingBatchSize: number;  // Default 50
  cacheExpiryDays: number;     // Default 7
  maxEmbeddingCache: number;   // Default 1000

  // Review Configuration
  reviewIntervalDays: number;  // Default 7
  enableSpacedRepetition: boolean;

  // Individual Skill configurations
  skillConfigurations?: Record<string, SkillConfig>;
  
  // Diagnostics Configuration
  diagnosticsFolder?: string;

  // Custom User System Prompt Preferences
  userSystemPromptPreferences?: string;

  // Custom User Configurations Folder
  userConfigFolder?: string;

  // Toggle for multi-agent cooperative Draft-Review loop
  draftReviewModeEnabled?: boolean;

  // Input area send options
  sendWithCmdEnter?: boolean;

  // UI Theme
  chatTheme?: string;
  terminalPreset?: 'green' | 'amber' | 'github-dark' | 'dracula';

  [key: string]: unknown;
}

export interface SkillConfig {
  enabled?: boolean;
  directCall?: boolean;
  requireConfirmation?: boolean;
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

export const DEFAULT_SETTINGS: MentatSettings = {
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

  browserlessApiKey: '',
  braveSearchApiKey: '',

  autoClassificationEnabled: true,
  linkSuggestionEnabled: true,
  chatEnabled: true,
  graphEnabled: true,
  reviewEnabled: true,

  skillsEnabled: true,
  requireSkillConfirmation: false,
  allowedSkills: [],
  maxTurns: 20,

  // Skill Invocation Configuration
  skillInvocationMode: 'auto', // Use hybrid auto strategy by default
  skillInvocationConfig: {
    mode: 'auto',
    detailFormat: 'markdown',
    enableCache: true,
    enableDynamicDiscovery: true,
    cacheConfig: {
      ttl: 3600000,  // 1 hour
      maxSize: 100   // Max 100 cached skills
    },
    directCallSkills: [
      'obsidian:read_note',
      'obsidian:query_notes',
      'obsidian:edit_note',
      'obsidian:web_search',
      'obsidian:ask_user',
      'obsidian:list_notes',
      'obsidian:web_fetch'
    ]
  },

  mcpServers: [],
  mcpTimeout: 30000,
  mcpRetryAttempts: 3,

  // Context Manager Configuration
  contextManager: {
    defaultStrategy: 'sliding-window',
    llmDefaults: {
      maxMessages: 50,
      includeSystemMessages: true,
      includeToolCalls: true,
      transformToolCalls: true
    },
    displayDefaults: {
      includeSystemMessages: true,
      includeToolCalls: true
    },
    enableCache: true,
    cacheTTL: 300000 // 5 minutes
  },

  indexingBatchSize: 50,
  cacheExpiryDays: 7,
  maxEmbeddingCache: 1000,

  reviewIntervalDays: 7,
  enableSpacedRepetition: true,
  skillConfigurations: {},
  diagnosticsFolder: 'Mentat/Diagnostics',
  userSystemPromptPreferences: '',
  userConfigFolder: 'Mentat/Config',
  draftReviewModeEnabled: true,
  sendWithCmdEnter: false,
  chatTheme: 'terminal',
  terminalPreset: 'green'
};
