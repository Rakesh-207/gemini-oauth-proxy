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
        } else if (path === "/diagnose") {
            return this.handleDiagnose();
        } else if (path === "/health-check") {
            return this.handleHealthCheck();
        }

        return new Response("Unknown endpoint", { status: 404 });
    }

    /**
     * Diagnose OAuth configuration issues
     */
    private handleDiagnose(): Response {
        const clientId = this.env.OAUTH_CLIENT_ID || OAUTH_CLIENT_ID;
        const clientSecret = this.env.OAUTH_CLIENT_SECRET || OAUTH_CLIENT_SECRET;

        const issues: string[] = [];

        if (!clientId || clientId === "YOUR_CLIENT_ID") {
            issues.push("OAUTH_CLIENT_ID is not configured or uses placeholder value");
        }
        if (!clientSecret || clientSecret === "YOUR_CLIENT_SECRET") {
            issues.push("OAUTH_CLIENT_SECRET is not configured or uses placeholder value");
        }
        if (this.credentials.length === 0) {
            issues.push("No GCP_SERVICE_ACCOUNT_* credentials loaded");
        }

        // Check if any credential has a valid refresh token format
        const credentialIssues: string[] = [];
        for (let i = 0; i < this.credentials.length; i++) {
            const cred = this.credentials[i];
            if (!cred.refresh_token) {
                credentialIssues.push(`Account ${i + 1}: Missing refresh_token`);
            }
        }

        return new Response(JSON.stringify({
            status: issues.length === 0 ? "OK" : "ISSUES_DETECTED",
            oauthConfigured: {
                clientId: !!clientId && clientId !== "YOUR_CLIENT_ID",
                clientSecret: !!clientSecret && clientSecret !== "YOUR_CLIENT_SECRET",
            },
            credentialsLoaded: this.credentials.length,
            issues,
            credentialIssues: credentialIssues.slice(0, 5), // Limit output
        }, null, 2), {
            headers: { "Content-Type": "application/json" }
        });
    }

    /**
     * Health check - test each credential individually
     */
    private async handleHealthCheck(): Promise<Response> {
        const results: Array<{
            index: number;
            projectId: string;
            tokenRefresh: "ok" | "failed";
            apiCall: "ok" | "failed" | "skipped";
            error?: string;
        }> = [];

        for (let i = 0; i < this.credentials.length; i++) {
            const cred = this.credentials[i];
            const projectId = cred.project_id || "unknown";

            // Try to refresh token
            const token = await this.refreshToken(cred.refresh_token);

            if (!token) {
                results.push({
                    index: i,
                    projectId,
                    tokenRefresh: "failed",
                    apiCall: "skipped",
                    error: "Token refresh failed"
                });
                continue;
            }

            // Try a minimal API call
            const testModel = "gemini-3-flash-preview";
            const testRequest = {
                model: testModel,
                request: {
                    contents: [{ role: "user", parts: [{ text: "Hi" }] }],
                    generationConfig: { maxOutputTokens: 5 }
                },
                project: projectId,
            };

            try {
                const response = await fetch(
                    `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:generateContent`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${token.accessToken}`,
                        },
                        body: JSON.stringify(testRequest),
                    }
                );

                if (response.ok) {
                    results.push({
                        index: i,
                        projectId,
                        tokenRefresh: "ok",
                        apiCall: "ok"
                    });
                } else {
                    const errorBody = await response.text();
                    results.push({
                        index: i,
                        projectId,
                        tokenRefresh: "ok",
                        apiCall: "failed",
                        error: `HTTP ${response.status}: ${errorBody.slice(0, 200)}`
                    });
                }
            } catch (e) {
                results.push({
                    index: i,
                    projectId,
                    tokenRefresh: "ok",
                    apiCall: "failed",
                    error: `Fetch error: ${String(e)}`
                });
            }
        }

        const working = results.filter(r => r.apiCall === "ok");
        const failing = results.filter(r => r.apiCall !== "ok");

        return new Response(JSON.stringify({
            total: this.credentials.length,
            working: working.length,
            failing: failing.length,
            workingAccounts: working.map(r => ({ index: r.index, projectId: r.projectId })),
            failingAccounts: failing.map(r => ({ index: r.index, projectId: r.projectId, error: r.error })),
        }, null, 2), {
            headers: { "Content-Type": "application/json" }
        });
    }

    /**
     * Get a valid access token for the specified model type
     */
    private async handleGetToken(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const modelType = (url.searchParams.get("type") || "flash") as ModelType;

        const result = await this.getValidToken(modelType);

        if ("error" in result) {
            const status = result.errorType === "all_token_refresh_failed" ? 500 : 429;
            return new Response(JSON.stringify({ error: result.error, errorType: result.errorType }), {
                status,
                headers: { "Content-Type": "application/json" }
            });
        }

        return new Response(JSON.stringify({
            token: result.token,
            accountIndex: result.accountIndex,
            projectId: result.projectId,
        }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    /**
     * Get a valid token, rotating if necessary
     * Returns detailed error info when failing
     */
    private async getValidToken(modelType: ModelType): Promise<{ token: string; accountIndex: number; projectId: string } | { error: string; errorType: "no_credentials" | "all_rate_limited" | "all_token_refresh_failed" }> {
        const now = Date.now();
        const totalAccounts = this.credentials.length;

        if (totalAccounts === 0) {
            console.error("No credentials loaded!");
            return { error: "No credentials loaded", errorType: "no_credentials" };
        }

        let rateLimitedCount = 0;
        let tokenRefreshFailedCount = 0;

        // Try each account starting from current index
        for (let attempt = 0; attempt < totalAccounts; attempt++) {
            const idx = (this.currentIndex + attempt) % totalAccounts;

            // Check rate limit
            const rateLimit = this.rateLimits.get(idx);
            if (rateLimit) {
                const isLimited = modelType === "pro" ? rateLimit.proLimited : rateLimit.flashLimited;
                if (isLimited && now < rateLimit.limitedUntil) {
                    rateLimitedCount++;
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
                const projectId = this.credentials[idx].project_id || "";
                return { token, accountIndex: idx, projectId };
            } else {
                tokenRefreshFailedCount++;
            }
        }

        // Determine the actual cause of failure
        if (rateLimitedCount === totalAccounts) {
            console.error(`All ${totalAccounts} accounts are rate-limited`);
            return { error: "All accounts rate-limited", errorType: "all_rate_limited" };
        } else if (tokenRefreshFailedCount > 0) {
            console.error(`Token refresh failed for ${tokenRefreshFailedCount} accounts, ${rateLimitedCount} rate-limited`);
            return {
                error: `Token refresh failed for ${tokenRefreshFailedCount} accounts. Check OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET secrets.`,
                errorType: "all_token_refresh_failed"
            };
        }

        return { error: "All accounts exhausted", errorType: "all_rate_limited" };
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
        const clientId = this.env.OAUTH_CLIENT_ID || OAUTH_CLIENT_ID;
        const clientSecret = this.env.OAUTH_CLIENT_SECRET || OAUTH_CLIENT_SECRET;

        // Validate OAuth credentials are configured
        if (!clientId || clientId === "YOUR_CLIENT_ID") {
            console.error("OAUTH_CLIENT_ID is not configured! Set it as a Cloudflare secret.");
            return null;
        }
        if (!clientSecret || clientSecret === "YOUR_CLIENT_SECRET") {
            console.error("OAUTH_CLIENT_SECRET is not configured! Set it as a Cloudflare secret.");
            return null;
        }

        try {
            const response = await fetch(OAUTH_REFRESH_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    refresh_token: refreshToken,
                    grant_type: "refresh_token",
                }),
            });

            if (!response.ok) {
                const error = await response.text();
                console.error(`Token refresh failed (${response.status}):`, error);
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
        if ("error" in tokenResult) {
            const status = tokenResult.errorType === "all_token_refresh_failed" ? 500 : 429;
            return new Response(JSON.stringify({ error: tokenResult.error, errorType: tokenResult.errorType }), {
                status,
                headers: { "Content-Type": "application/json" }
            });
        }

        // Resolve model alias
        const actualModel = MODEL_ALIASES[modelId] || modelId;

        // Build API URL - add ?alt=sse for streaming
        const method = stream ? "streamGenerateContent" : "generateContent";
        const apiUrl = stream
            ? `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}?alt=sse`
            : `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`;

        // Build Code Assist API request format
        // Format: { model, request: { contents, generationConfig, ... }, project }
        const geminiRequest = {
            model: actualModel,  // No "models/" prefix for Code Assist API
            request: requestBody as Record<string, unknown>,
            project: tokenResult.projectId,
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

            // Log which credential is being used
            console.log(`[Proxy] Using account ${tokenResult.accountIndex}, project: ${tokenResult.projectId}, model: ${actualModel}`);

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
                if (!("error" in retryToken)) {
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

                const retryError = retryToken as { error: string; errorType: string };
                return new Response(JSON.stringify({ error: retryError.error, errorType: retryError.errorType }), {
                    status: retryError.errorType === "all_token_refresh_failed" ? 500 : 429,
                    headers: {
                        "Content-Type": "application/json",
                        "X-Account-Index": String(tokenResult.accountIndex),
                        "X-Project-ID": tokenResult.projectId,
                    }
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

            // Create response with debugging headers
            const headers = new Headers(response.headers);
            headers.set("X-Account-Index", String(tokenResult.accountIndex));
            headers.set("X-Project-ID", tokenResult.projectId);

            return new Response(response.body, {
                status: response.status,
                headers,
            });
        } catch (e) {
            console.error("Proxy error:", e);
            return new Response(JSON.stringify({ error: "Proxy request failed", details: String(e) }), {
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
