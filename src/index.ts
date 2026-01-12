import { Hono } from "hono";
import { Env, ChatCompletionRequest, ChatMessage, StreamChunk, UsageData } from "./types";
import { KeyRotator } from "./KeyRotator";
import { SUPPORTED_MODELS, MODEL_ALIASES, CODE_ASSIST_ENDPOINT, CODE_ASSIST_API_VERSION } from "./config";

// Create the main Hono app
const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use("*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (c.req.method === "OPTIONS") {
        c.status(204);
        return c.body(null);
    }

    await next();
});

// Optional API key authentication
app.use("/v1/*", async (c, next) => {
    const apiKey = c.env.OPENAI_API_KEY;

    if (apiKey) {
        const authHeader = c.req.header("Authorization");
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return c.json({ error: "Missing Authorization header" }, 401);
        }

        const providedKey = authHeader.substring(7);
        if (providedKey !== apiKey) {
            return c.json({ error: "Invalid API key" }, 401);
        }
    }

    await next();
});

// Root endpoint
app.get("/", (c) => {
    return c.json({
        name: "Gemini CLI OpenAI Worker (High-Performance)",
        description: "OpenAI-compatible API for Google Gemini with DO-based OAuth rotation",
        version: "2.0.0",
        authentication: {
            required: !!c.env.OPENAI_API_KEY,
            type: c.env.OPENAI_API_KEY ? "Bearer token" : "None"
        },
        endpoints: {
            chat_completions: "/v1/chat/completions",
            models: "/v1/models",
            status: "/v1/status"
        }
    });
});

// Health check
app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// List models
app.get("/v1/models", (c) => {
    const models = Object.entries(SUPPORTED_MODELS).map(([id, info]) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google-gemini-cli",
        context_window: info.contextWindow,
        max_tokens: info.maxTokens
    }));

    return c.json({
        object: "list",
        data: models
    });
});

// Status endpoint - shows DO state
app.get("/v1/status", async (c) => {
    const id = c.env.KEY_ROTATOR.idFromName("main");
    const stub = c.env.KEY_ROTATOR.get(id);

    const statusResponse = await stub.fetch(new Request("http://internal/status"));
    const status = await statusResponse.json();

    return c.json(status);
});

// Diagnose endpoint - helps identify OAuth configuration issues
app.get("/v1/diagnose", async (c) => {
    const id = c.env.KEY_ROTATOR.idFromName("main");
    const stub = c.env.KEY_ROTATOR.get(id);

    const diagnoseResponse = await stub.fetch(new Request("http://internal/diagnose"));
    const diagnose = await diagnoseResponse.json();

    return c.json(diagnose);
});

// Chat completions endpoint
app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json<ChatCompletionRequest>();
    let { model, messages, stream = true } = body;

    // Default to gemini-3-flash-preview if not specified
    if (!model) {
        model = "gemini-3-flash-preview";
    }

    // Get the DO stub
    const id = c.env.KEY_ROTATOR.idFromName("main");
    const stub = c.env.KEY_ROTATOR.get(id);

    // Convert messages to Gemini format
    const geminiMessages = convertToGeminiFormat(messages);

    // Extract system prompt
    const systemInstruction = extractSystemPrompt(messages);

    // Build Gemini request body
    const geminiRequest: Record<string, unknown> = {
        contents: geminiMessages,
        generationConfig: {
            maxOutputTokens: body.max_tokens || 8192,
            temperature: body.temperature,
            topP: body.top_p,
        }
    };

    if (systemInstruction) {
        geminiRequest.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    // Handle thinking mode
    const enableRealThinking = c.env.ENABLE_REAL_THINKING === "true";
    const streamThinkingAsContent = c.env.STREAM_THINKING_AS_CONTENT === "true";

    if (enableRealThinking) {
        geminiRequest.generationConfig = {
            ...geminiRequest.generationConfig as object,
            thinkingConfig: {
                thinkingBudget: 0, // Restricted as requested
            }
        };
    }

    // Resolve model alias
    const actualModel = MODEL_ALIASES[model] || model;

    if (stream) {
        // Streaming response
        return handleStreamingRequest(c, stub, actualModel, geminiRequest, model, streamThinkingAsContent);
    } else {
        // Non-streaming response
        return handleNonStreamingRequest(c, stub, actualModel, geminiRequest, model);
    }
});

/**
 * Handle streaming chat completion
 */
async function handleStreamingRequest(
    c: any,
    stub: DurableObjectStub,
    actualModel: string,
    geminiRequest: Record<string, unknown>,
    requestModel: string,
    streamThinkingAsContent: boolean
): Promise<Response> {
    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Request proxy from DO
    const proxyResponse = await stub.fetch(new Request("http://internal/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            modelId: requestModel,
            requestBody: geminiRequest,
            stream: true,
        }),
    }));

    if (!proxyResponse.ok) {
        const error = await proxyResponse.json() as { error: string };
        return c.json({ error: error.error || "Proxy request failed" }, proxyResponse.status);
    }

    // Transform SSE stream to OpenAI format
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Use closure variables for state instead of custom properties on transformer
    let buffer = "";
    let isInThinking = false;

    const transformStream = new TransformStream({
        async transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
            const text = decoder.decode(chunk, { stream: true });
            buffer += text;

            // Process complete SSE lines
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]") {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    continue;
                }

                try {
                    const parsed = JSON.parse(data);
                    const candidates = parsed.candidates || parsed.response?.candidates || [];

                    for (const candidate of candidates) {
                        const parts = candidate.content?.parts || candidate.parts || [];
                        for (const part of parts) {
                            if (part.text) {
                                let content = part.text;
                                const isThinkingPart = part.thought === true;

                                // Handle thinking content
                                if (isThinkingPart && streamThinkingAsContent) {
                                    if (!isInThinking) {
                                        content = "<thinking>" + content;
                                        isInThinking = true;
                                    }
                                } else if (isInThinking && !isThinkingPart) {
                                    content = "</thinking>" + content;
                                    isInThinking = false;
                                }

                                const sseChunk = {
                                    id: completionId,
                                    object: "chat.completion.chunk",
                                    created,
                                    model: requestModel,
                                    choices: [{
                                        index: 0,
                                        delta: { content },
                                        finish_reason: null
                                    }]
                                };

                                controller.enqueue(encoder.encode(`data: ${JSON.stringify(sseChunk)}\n\n`));
                            }
                        }
                    }

                    // Check for finish
                    if (parsed.usageMetadata || (candidates[0]?.finishReason && candidates[0].finishReason !== "STOP")) {
                        const usage = parsed.usageMetadata;
                        const finalChunk = {
                            id: completionId,
                            object: "chat.completion.chunk",
                            created,
                            model: requestModel,
                            choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: "stop"
                            }],
                            usage: usage ? {
                                prompt_tokens: usage.promptTokenCount || 0,
                                completion_tokens: usage.candidatesTokenCount || 0,
                                total_tokens: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0)
                            } : undefined
                        };
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
                    }
                } catch (e) {
                    // Skip malformed JSON
                }
            }
        },

        flush(controller: TransformStreamDefaultController) {
            // Close thinking tag if still open
            if (isInThinking) {
                const closeChunk = {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model: requestModel,
                    choices: [{
                        index: 0,
                        delta: { content: "</thinking>" },
                        finish_reason: null
                    }]
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(closeChunk)}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
    });

    const responseBody = proxyResponse.body?.pipeThrough(transformStream);

    return new Response(responseBody, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        }
    });
}

/**
 * Handle non-streaming chat completion
 */
async function handleNonStreamingRequest(
    c: any,
    stub: DurableObjectStub,
    actualModel: string,
    geminiRequest: Record<string, unknown>,
    requestModel: string
): Promise<Response> {
    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Request proxy from DO
    const proxyResponse = await stub.fetch(new Request("http://internal/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            modelId: requestModel,
            requestBody: geminiRequest,
            stream: false,
        }),
    }));

    if (!proxyResponse.ok) {
        const error = await proxyResponse.json() as { error: string };
        return c.json({ error: error.error || "Proxy request failed" }, proxyResponse.status);
    }

    // Code Assist API returns: { response: { candidates: [...], usageMetadata: {...} } }
    const geminiResponse = await proxyResponse.json() as {
        response?: {
            candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
            }>;
            usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
            };
        };
        // Fallback for direct format
        candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
        }>;
        usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
        };
    };

    // Extract content - try response.candidates first (Code Assist format), then direct candidates
    const candidates = geminiResponse.response?.candidates || geminiResponse.candidates || [];
    const content = candidates[0]?.content?.parts?.[0]?.text || "";
    const usage = geminiResponse.response?.usageMetadata || geminiResponse.usageMetadata;

    return c.json({
        id: completionId,
        object: "chat.completion",
        created,
        model: requestModel,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content
            },
            finish_reason: "stop"
        }],
        usage: usage ? {
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0)
        } : undefined
    });
}

/**
 * Convert OpenAI messages to Gemini format
 */
function convertToGeminiFormat(messages: ChatMessage[]): Array<{ role: string; parts: Array<{ text: string }> }> {
    return messages
        .filter(msg => msg.role !== "system") // System handled separately
        .map(msg => {
            const role = msg.role === "assistant" ? "model" : "user";

            let text = "";
            if (typeof msg.content === "string") {
                text = msg.content;
            } else if (Array.isArray(msg.content)) {
                text = msg.content
                    .filter(c => c.type === "text")
                    .map(c => c.text || "")
                    .join("\n");
            }

            return {
                role,
                parts: [{ text }]
            };
        });
}

/**
 * Extract system prompt from messages
 */
function extractSystemPrompt(messages: ChatMessage[]): string | null {
    const systemMessage = messages.find(m => m.role === "system");
    if (!systemMessage) return null;

    if (typeof systemMessage.content === "string") {
        return systemMessage.content;
    }

    if (Array.isArray(systemMessage.content)) {
        return systemMessage.content
            .filter(c => c.type === "text")
            .map(c => c.text || "")
            .join("\n");
    }

    return null;
}

// Export the app and Durable Object
export default app;
export { KeyRotator };
