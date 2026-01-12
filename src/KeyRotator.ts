import {
    Env,
    OAuth2Credentials,
    CachedToken,
    RateLimitState,
    ModelType,
    ChatMessage,
    ChatCompletionRequest,
} from "./types";
import {
    OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET,
    OAUTH_REFRESH_URL,
    TOKEN_BUFFER_TIME,
    RATE_LIMIT_COOLDOWN,
    TOTAL_ACCOUNTS,
    MODEL_ALIASES,
    CODE_ASSIST_ENDPOINT,
    CODE_ASSIST_API_VERSION,
} from "./config";

interface RotatorState {
    currentIndex: number;
    credentials: OAuth2Credentials[];
    tokenCache: Map<number, CachedToken>;
    rateLimits: Map<number, RateLimitState>;
}

/**
 * KeyRotator Durable Object
 * 
 * High-performance OAuth credential rotation with:
 * - RAM-cached access tokens (0ms retrieval)
 * - Smart Pro vs Flash rotation
 * - Rate limit tracking per account
 */
export class KeyRotator implements DurableObject {
    private state: DurableObjectState;
    private env: Env;

    // Hot state - lives in RAM
    private currentIndex: number = 0;
    private credentials: OAuth2Credentials[] = [];
    private tokenCache: Map<number, CachedToken> = new Map();
    private rateLimits: Map<number, RateLimitState> = new Map();
    private initialized: boolean = false;

    constructor(state: DurableObjectState, env: Env) {
        this.state = state;
        this.env = env;

        // Block concurrency while loading state
        this.state.blockConcurrencyWhile(async () => {
            await this.loadState();
        });
    }

    /**
     * Load credentials from env secrets and restore state from DO storage
     */
    private async loadState(): Promise<void> {
        // Load credentials from environment secrets
        this.credentials = [];
        for (let i = 1; i <= TOTAL_ACCOUNTS; i++) {
            const secretKey = `GCP_SERVICE_ACCOUNT_${i}` as keyof Env;
            const credentialJson = this.env[secretKey] as string | undefined;

            if (credentialJson) {
                try {
                    const cred = JSON.parse(credentialJson) as OAuth2Credentials;
                    this.credentials.push(cred);
                } catch (e) {
                    console.error(`Failed to parse credential ${i}:`, e);
                }
            }
        }

        console.log(`Loaded ${this.credentials.length} OAuth credentials`);

        // Restore persisted state
        const storedIndex = await this.state.storage.get<number>("currentIndex");
        if (storedIndex !== undefined) {
            this.currentIndex = storedIndex;
        }

        this.initialized = true;
    }

    /**
     * Main entry point - handles all requests
     */
    async fetch(request: Request): Promise<Response> {
        if (!this.initialized) {
            await this.loadState();
        }

        const url = new URL(request.url);
        const path = url.pathname;

        // Route based on path
        if (path === "/get-token") {
            return this.handleGetToken(request);
        } else if (path === "/report-rate-limit") {
            return this.handleRateLimitReport(request);
        } else if (path === "/proxy") {
            return this.handleProxy(request);
        } else if (path === "/status") {
            return this.handleStatus();
        }

        return new Response("Unknown endpoint", { status: 404 });
    }

    /**
     * Get a valid access token for the specified model type
     */
    private async handleGetToken(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const modelType = (url.searchParams.get("type") || "flash") as ModelType;

        const result = await this.getValidToken(modelType);

        if (!result) {
            return new Response(JSON.stringify({ error: "All accounts rate-limited" }), {
                status: 429,
                headers: { "Content-Type": "application/json" }
            });
        }

        return new Response(JSON.stringify({
            token: result.token,
            accountIndex: result.accountIndex,
        }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    /**
     * Get a valid token, rotating if necessary
     */
    private async getValidToken(modelType: ModelType): Promise<{ token: string; accountIndex: number } | null> {
        const now = Date.now();
        const totalAccounts = this.credentials.length;

        if (totalAccounts === 0) {
            console.error("No credentials loaded!");
            return null;
        }

        // Try each account starting from current index
        for (let attempt = 0; attempt < totalAccounts; attempt++) {
            const idx = (this.currentIndex + attempt) % totalAccounts;

            // Check rate limit
            const rateLimit = this.rateLimits.get(idx);
            if (rateLimit) {
                const isLimited = modelType === "pro" ? rateLimit.proLimited : rateLimit.flashLimited;
                if (isLimited && now < rateLimit.limitedUntil) {
                    continue; // Skip this account
                }
                // Clear expired rate limit
                if (now >= rateLimit.limitedUntil) {
                    this.rateLimits.delete(idx);
                }
            }

            // Get or refresh token
            const token = await this.getOrRefreshToken(idx);
            if (token) {
                // Update current index if we rotated
                if (attempt > 0) {
                    this.currentIndex = idx;
                    // Fire-and-forget persistence
                    this.state.storage.put("currentIndex", this.currentIndex);
                }
                return { token, accountIndex: idx };
            }
        }

        return null; // All accounts exhausted
    }

    /**
     * Get cached token or refresh if needed
     */
    private async getOrRefreshToken(accountIndex: number): Promise<string | null> {
        const now = Date.now();

        // Check RAM cache first (0ms!)
        const cached = this.tokenCache.get(accountIndex);
        if (cached && cached.expiryDate - TOKEN_BUFFER_TIME > now) {
            return cached.accessToken;
        }

        // Need to refresh
        const cred = this.credentials[accountIndex];
        if (!cred) {
            return null;
        }

        try {
            const newToken = await this.refreshToken(cred.refresh_token);
            if (newToken) {
                // Cache in RAM
                this.tokenCache.set(accountIndex, {
                    accessToken: newToken.accessToken,
                    expiryDate: newToken.expiryDate,
                    accountIndex,
                });
                return newToken.accessToken;
            }
        } catch (e) {
            console.error(`Failed to refresh token for account ${accountIndex}:`, e);
        }

        return null;
    }

    /**
     * Refresh an OAuth token
     */
    private async refreshToken(refreshToken: string): Promise<{ accessToken: string; expiryDate: number } | null> {
        try {
            const response = await fetch(OAUTH_REFRESH_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    client_id: OAUTH_CLIENT_ID,
                    client_secret: OAUTH_CLIENT_SECRET,
                    refresh_token: refreshToken,
                    grant_type: "refresh_token",
                }),
            });

            if (!response.ok) {
                const error = await response.text();
                console.error("Token refresh failed:", error);
                return null;
            }

            const data = await response.json() as { access_token: string; expires_in: number };

            return {
                accessToken: data.access_token,
                expiryDate: Date.now() + data.expires_in * 1000,
            };
        } catch (e) {
            console.error("Token refresh error:", e);
            return null;
        }
    }

    /**
     * Handle rate limit report from worker
     */
    private async handleRateLimitReport(request: Request): Promise<Response> {
        const body = await request.json() as { accountIndex: number; modelType: ModelType };
        const { accountIndex, modelType } = body;

        const now = Date.now();
        const existing = this.rateLimits.get(accountIndex) || {
            proLimited: false,
            flashLimited: false,
            limitedUntil: 0,
        };

        if (modelType === "pro") {
            existing.proLimited = true;
        } else {
            existing.flashLimited = true;
        }
        existing.limitedUntil = now + RATE_LIMIT_COOLDOWN;

        this.rateLimits.set(accountIndex, existing);

        // Rotate to next account
        this.currentIndex = (accountIndex + 1) % this.credentials.length;
        this.state.storage.put("currentIndex", this.currentIndex);

        console.log(`Rate limit reported for account ${accountIndex} (${modelType}), rotated to ${this.currentIndex}`);

        return new Response(JSON.stringify({ rotatedTo: this.currentIndex }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    /**
     * Proxy a request to Gemini API with automatic token management
     */
    private async handleProxy(request: Request): Promise<Response> {
        const body = await request.json() as {
            modelId: string;
            requestBody: unknown;
            stream: boolean;
        };

        const { modelId, requestBody, stream } = body;
        const modelType: ModelType = modelId.includes("pro") ? "pro" : "flash";

        // Get valid token
        const tokenResult = await this.getValidToken(modelType);
        if (!tokenResult) {
            return new Response(JSON.stringify({ error: "All accounts rate-limited" }), {
                status: 429,
                headers: { "Content-Type": "application/json" }
            });
        }

        // Resolve model alias
        const actualModel = MODEL_ALIASES[modelId] || modelId;

        // Build API URL
        const method = stream ? "streamGenerateContent" : "generateContent";
        const apiUrl = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`;

        // Make request
        const geminiRequest = {
            model: `models/${actualModel}`,
            ...(requestBody as Record<string, unknown>),
        };

        try {
            const response = await fetch(apiUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${tokenResult.token}`,
                },
                body: JSON.stringify(geminiRequest),
            });

            // Handle rate limit
            if (response.status === 429 || response.status === 503) {
                // Report rate limit and retry with next account
                await this.handleRateLimitReport(new Request("http://internal/report-rate-limit", {
                    method: "POST",
                    body: JSON.stringify({
                        accountIndex: tokenResult.accountIndex,
                        modelType,
                    }),
                }));

                // Retry once with new account
                const retryToken = await this.getValidToken(modelType);
                if (retryToken) {
                    const retryResponse = await fetch(apiUrl, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${retryToken.token}`,
                        },
                        body: JSON.stringify(geminiRequest),
                    });

                    return new Response(retryResponse.body, {
                        status: retryResponse.status,
                        headers: retryResponse.headers,
                    });
                }

                return new Response(JSON.stringify({ error: "All accounts rate-limited after retry" }), {
                    status: 429,
                    headers: { "Content-Type": "application/json" }
                });
            }

            // Handle 401 - token might be invalid, clear cache
            if (response.status === 401) {
                this.tokenCache.delete(tokenResult.accountIndex);
                // Retry with fresh token
                const freshToken = await this.getOrRefreshToken(tokenResult.accountIndex);
                if (freshToken) {
                    const retryResponse = await fetch(apiUrl, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${freshToken}`,
                        },
                        body: JSON.stringify(geminiRequest),
                    });

                    return new Response(retryResponse.body, {
                        status: retryResponse.status,
                        headers: retryResponse.headers,
                    });
                }
            }

            return new Response(response.body, {
                status: response.status,
                headers: response.headers,
            });
        } catch (e) {
            console.error("Proxy error:", e);
            return new Response(JSON.stringify({ error: "Proxy request failed" }), {
                status: 500,
                headers: { "Content-Type": "application/json" }
            });
        }
    }

    /**
     * Return status info
     */
    private handleStatus(): Response {
        const now = Date.now();
        const accounts: Array<{
            index: number;
            hasCredential: boolean;
            hasCachedToken: boolean;
            tokenExpiresIn: number | null;
            rateLimited: boolean;
        }> = [];

        for (let i = 0; i < this.credentials.length; i++) {
            const cached = this.tokenCache.get(i);
            const rateLimit = this.rateLimits.get(i);

            accounts.push({
                index: i,
                hasCredential: true,
                hasCachedToken: !!cached,
                tokenExpiresIn: cached ? Math.floor((cached.expiryDate - now) / 1000) : null,
                rateLimited: !!(rateLimit && now < rateLimit.limitedUntil),
            });
        }

        return new Response(JSON.stringify({
            currentIndex: this.currentIndex,
            totalAccounts: this.credentials.length,
            cachedTokens: this.tokenCache.size,
            rateLimitedAccounts: this.rateLimits.size,
            accounts,
        }, null, 2), {
            headers: { "Content-Type": "application/json" }
        });
    }
}
