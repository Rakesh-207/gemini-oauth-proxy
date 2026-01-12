// OAuth Configuration
export const OAUTH_CLIENT_ID = "YOUR_CLIENT_ID";
export const OAUTH_CLIENT_SECRET = "YOUR_CLIENT_SECRET";
export const OAUTH_REFRESH_URL = "https://oauth2.googleapis.com/token";

// Code Assist API Configuration
export const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const CODE_ASSIST_API_VERSION = "v1internal";

// Token Configuration
export const TOKEN_BUFFER_TIME = 5 * 60 * 1000; // 5 minutes before expiry
export const RATE_LIMIT_COOLDOWN = 60 * 1000; // 60 seconds cooldown

// Model Mappings
export const MODEL_ALIASES: Record<string, string> = {
    "gemini-2.5-pro": "gemini-2.5-pro-preview-06-05",
    "gemini-2.5-flash": "gemini-2.5-flash-preview-05-20",
    "gemini-2.5-flash-lite": "gemini-2.5-flash-lite-preview-06-17",
    "gemini-3-flash-preview": "gemini-3-flash-preview",
};

// Supported Models with their context windows
// Supported Models with their context windows
export const SUPPORTED_MODELS: Record<string, { maxTokens: number; contextWindow: number; thinking: boolean }> = {
    // Default model: gemini-3-flash-preview
    // Rate limits: 20 req/day/account, 5 req/min/account, 250K tokens/min
    "gemini-3-flash-preview": { maxTokens: 65536, contextWindow: 1000000, thinking: true },
    "gemini-2.5-pro": { maxTokens: 65536, contextWindow: 1000000, thinking: true },
    "gemini-2.5-flash": { maxTokens: 65536, contextWindow: 1000000, thinking: true },
    "gemini-2.5-flash-lite": { maxTokens: 65536, contextWindow: 1000000, thinking: true },
};

// Total number of OAuth accounts
export const TOTAL_ACCOUNTS = 25;
