# Gemini OAuth Proxy

High-performance OpenAI-compatible proxy for Google Gemini, powered by Cloudflare Workers and Durable Objects.

## Features

- 🔐 **25 OAuth Account Rotation** - Automatic credential rotation with RAM-cached tokens (0ms latency)
- 🚀 **Durable Object State** - Hot token cache survives across requests
- ⚡ **Smart Rate Limit Handling** - Auto-rotates on 429/503. optimized for `gemini-3-flash-preview` limits (5 req/min).
- 🤖 **OpenAI Compatible** - Drop-in replacement for `/v1/chat/completions` (Defaults to `gemini-3-flash-preview`)
- 💭 **Thinking Mode** - Supports `<thinking>` tags (Budget: 0 by default)

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /v1/models` | List available models |
| `POST /v1/chat/completions` | Chat completion (streaming default) |
| `GET /v1/status` | View rotation state and cached tokens |
| `GET /health` | Health check |

## Deploy

```bash
npm install
npm run deploy
```

## Environment Secrets (in Cloudflare)

- `GCP_SERVICE_ACCOUNT_1` through `GCP_SERVICE_ACCOUNT_25` - OAuth credentials JSON
- `ENABLE_REAL_THINKING` - Enable Gemini thinking mode
- `STREAM_THINKING_AS_CONTENT` - Stream thinking as `<thinking>` tags
- `OPENAI_API_KEY` (optional) - Require auth for API access

## Architecture

```
Client → Worker (Hono) → KeyRotator DO → Gemini API
                              ↓
                         RAM Token Cache (0ms)
                         Rate Limit Tracker
                         25 OAuth Accounts
```

## License

MIT