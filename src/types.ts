// --- Safety Threshold Types ---
export type SafetyThreshold =
    | "OFF"
    | "BLOCK_NONE"
    | "BLOCK_FEW"
    | "BLOCK_SOME"
    | "BLOCK_ONLY_HIGH"
    | "HARM_BLOCK_THRESHOLD_UNSPECIFIED";

// --- OAuth2 Credentials Interface ---
export interface OAuth2Credentials {
    access_token: string;
    refresh_token: string;
    scope: string;
    token_type: string;
    id_token: string;
    expiry_date: number;
    project_id?: string;  // Required for Code Assist API
}

// --- Cached Token Interface ---
export interface CachedToken {
    accessToken: string;
    expiryDate: number;
    accountIndex: number;
}

// --- Rate Limit State ---
export interface RateLimitState {
    proLimited: boolean;
    flashLimited: boolean;
    limitedUntil: number;
}

// --- Environment Variable Typings ---
export interface Env {
    // KV Namespace
    GEMINI_CLI_KV: KVNamespace;

    // Durable Object binding
    KEY_ROTATOR: DurableObjectNamespace;

    // OAuth credentials (1-25)
    GCP_SERVICE_ACCOUNT_1?: string;
    GCP_SERVICE_ACCOUNT_2?: string;
    GCP_SERVICE_ACCOUNT_3?: string;
    GCP_SERVICE_ACCOUNT_4?: string;
    GCP_SERVICE_ACCOUNT_5?: string;
    GCP_SERVICE_ACCOUNT_6?: string;
    GCP_SERVICE_ACCOUNT_7?: string;
    GCP_SERVICE_ACCOUNT_8?: string;
    GCP_SERVICE_ACCOUNT_9?: string;
    GCP_SERVICE_ACCOUNT_10?: string;
    GCP_SERVICE_ACCOUNT_11?: string;
    GCP_SERVICE_ACCOUNT_12?: string;
    GCP_SERVICE_ACCOUNT_13?: string;
    GCP_SERVICE_ACCOUNT_14?: string;
    GCP_SERVICE_ACCOUNT_15?: string;
    GCP_SERVICE_ACCOUNT_16?: string;
    GCP_SERVICE_ACCOUNT_17?: string;
    GCP_SERVICE_ACCOUNT_18?: string;
    GCP_SERVICE_ACCOUNT_19?: string;
    GCP_SERVICE_ACCOUNT_20?: string;
    GCP_SERVICE_ACCOUNT_21?: string;
    GCP_SERVICE_ACCOUNT_22?: string;
    GCP_SERVICE_ACCOUNT_23?: string;
    GCP_SERVICE_ACCOUNT_24?: string;
    GCP_SERVICE_ACCOUNT_25?: string;

    // OAuth Client Secrets
    OAUTH_CLIENT_ID?: string;
    OAUTH_CLIENT_SECRET?: string;

    // Feature flags
    ENABLE_REAL_THINKING?: string;
    STREAM_THINKING_AS_CONTENT?: string;
    OPENAI_API_KEY?: string;

    // Safety settings
    GEMINI_MODERATION_HARASSMENT_THRESHOLD?: SafetyThreshold;
    GEMINI_MODERATION_HATE_SPEECH_THRESHOLD?: SafetyThreshold;
    GEMINI_MODERATION_SEXUALLY_EXPLICIT_THRESHOLD?: SafetyThreshold;
    GEMINI_MODERATION_DANGEROUS_CONTENT_THRESHOLD?: SafetyThreshold;
}

// --- Model Types ---
export type ModelType = "pro" | "flash";

// --- Chat Message Types ---
export interface ChatMessage {
    role: string;
    content: string | MessageContent[];
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface MessageContent {
    type: "text" | "image_url" | "input_audio" | "input_video" | "input_pdf";
    text?: string;
    image_url?: {
        url: string;
        detail?: "low" | "high" | "auto";
    };
    input_audio?: {
        data: string;
        format: string;
    };
    input_video?: {
        data: string;
        format: string;
        url?: string;
    };
    input_pdf?: {
        data: string;
    };
}

export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

export interface Tool {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

export type ToolChoice = "none" | "auto" | { type: "function"; function: { name: string } };

// --- Request/Response Types ---
export interface ChatCompletionRequest {
    model?: string;
    messages: ChatMessage[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string | string[];
    tools?: Tool[];
    tool_choice?: ToolChoice;
}

export interface StreamChunk {
    type: "text" | "usage" | "reasoning" | "thinking_content" | "real_thinking" | "tool_code";
    data: string | UsageData | ReasoningData;
}

export interface UsageData {
    inputTokens: number;
    outputTokens: number;
}

export interface ReasoningData {
    reasoning: string;
    toolCode?: string;
}

// --- Gemini API Types ---
export interface GeminiCandidate {
    content?: {
        parts?: Array<{ text?: string }>;
    };
    parts?: Array<{ text?: string }>;
    text?: string;
}

export interface GeminiUsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
}

export interface GeminiResponse {
    response?: {
        candidates?: GeminiCandidate[];
        usageMetadata?: GeminiUsageMetadata;
    };
    candidates?: GeminiCandidate[];
    usageMetadata?: GeminiUsageMetadata;
}
