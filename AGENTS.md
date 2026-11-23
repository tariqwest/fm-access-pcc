# AGENTS.md

> Machine-readable project context for AI agents working in this codebase.

## Project Identity

- **Name**: fm-access-pcc
- **Purpose**: TypeScript library + HTTP server accessing Apple's Foundation Models through Terminal-hosted `fm serve`. Exposes both `system` (on-device) and `pcc` (Private Cloud Compute) models programmatically and via REST API; standalone CLI calls support quota usage and token counting.
- **Repository**: https://github.com/tariqwest/fm-access-pcc
- **Binary**: `/usr/bin/fm` (macOS 27+)

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode, ESM)
- **Server**: Hono
- **Validation**: Zod v4
- **Testing**: Vitest
- **Build**: tsc (outputs to `dist/`)
- **Package manager**: bun (lockfile: `bun.lock`)

## Project Structure

```
fm-access-pcc/
├── src/
│   ├── core/                  # Library layer — no server framework dependencies
│   │   ├── types.ts           # Zod schemas, inferred TypeScript types
│   │   ├── transport.ts       # Generation, chat, streaming, and discovery over serve
│   │   ├── fm-serve.ts        # HTTP client over fm serve Unix socket
│   │   ├── serve-bootstrap.ts # Terminal-hosted serve auto-start
│   │   ├── respond.ts         # Public respond() → transport
│   │   ├── chat.ts            # In-memory history sessions over transport
│   │   ├── models.ts          # Availability + quota
│   │   ├── tokens.ts          # fm count-tokens
│   │   └── index.ts           # Barrel export
│   ├── server/                # HTTP adapter layer (Hono)
│   │   ├── routes/
│   │   │   ├── native.ts      # /fm/* routes (supported library operations)
│   │   │   └── openai.ts      # /v1/* routes (OpenAI Chat Completions compatible)
│   │   └── index.ts           # createApp(), createServer()
│   └── index.ts               # Package entry — re-exports core + server
├── scripts/
│   └── release.sh             # npm + GitHub Release automation
├── .agents/
│   └── plans/                 # Architectural decision records
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Package Exports

```json
{
  ".": "./dist/core/index.js",        // Library (no HTTP server)
  "./server": "./dist/server/index.js" // Server factory
}
```

Consumers import as:
- `import { respond, createChatSession } from 'fm-access-pcc'` — library only
- `import { createServer } from 'fm-access-pcc/server'` — server factory

## Core Library API

### `respond(prompt, options?): Promise<RespondResult> | AsyncIterable<RespondResult>`

Text generation with optional history over Terminal-hosted `fm serve`. Returns a Promise normally, or an AsyncIterable when `options.stream` is true.

**Options** (all optional):
- `model`: `'system' | 'pcc'`
- `instructions`: system prompt string
- `stream`: boolean (enables streaming)
- `history`: prior conversation messages with `role` and `content`
- `signal`: `AbortSignal` for cancellation (library only, not a JSON request option)

CLI-only generation options are not supported.

### `createChatSession(options?): Promise<ChatSession>`

Creates an in-memory, history-backed multi-turn chat session over `fm serve`. No chat subprocess is created.

**Options**: `model`, `instructions`

**ChatSession interface**:
- `.id`: string — unique session identifier
- `.send(message)`: Promise<string> — send history and message, get response
- `.close()`: Promise<void> — discard session state

### `closeChatSession(id): boolean`

Close a session by ID. Returns false if not found.

### `getAvailableModels(model?): Promise<ModelAvailability[]>`

Check which models are available through Terminal-hosted `fm serve`. Optionally filter by model. No direct CLI availability check is performed.

### `getQuotaUsage(model?): Promise<QuotaUsage[]>`

Check PCC quota. Optionally filter by model.

### `countTokens(prompt, options?): Promise<TokenCountResult>`

Count tokens for a prompt. System model only.

## HTTP API Routes

### Native API (`/fm/*`)

| Method | Path | Description |
|--------|------|-------------|
| POST | /fm/respond | Single-turn generation |
| POST | /fm/chat | Create session + send first message |
| DELETE | /fm/chat/:session_id | Close session |
| GET | /fm/models/available | Model availability |
| GET | /fm/quota | Quota usage |
| POST | /fm/token-count | Token counting |
| GET | /health | Health check |

### OpenAI-Compatible API (`/v1/*`)

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/models | List models (OpenAI format) |
| POST | /v1/chat/completions | Chat completions (streaming + non-streaming) |

**Mapping rules for `/v1/chat/completions`**:
- `model` → transport model selection
- `messages[role=system]` → combined `instructions`
- Last non-system message → prompt; earlier non-system messages → `history`
- `stream: true` → serve-only SSE response with `data: [DONE]` sentinel
- Sampling controls such as `temperature` are not forwarded

## Commands

```bash
bun install          # Install dependencies
bun run test         # Run all tests (vitest)
bun run typecheck    # TypeScript type check (tsc --noEmit)
bun run build        # Clean build to dist/
bun run start        # Start server on port 8000
bun run release      # Release to npm + GitHub
```

## Testing Conventions

- Tests are co-located: `src/core/respond.test.ts` next to `src/core/respond.ts`
- Transport clients and CLI interactions are mocked (`child_process.spawn` for quota, token counting, and bootstrap); no PTY dependency is used
- Server tests use Hono's built-in `app.request()` — no supertest needed
- TDD approach: tests written before implementation

## Key Design Decisions

1. **Library-first architecture**: Core has no HTTP server framework dependencies. Server is a thin adapter.
2. **History-backed chat**: Sessions keep messages and call the serve transport. Closing a session deletes its state; there is no PTY process or legacy transport selection.
3. **Terminal-hosted `fm serve --socket` for PCC**: Validated multi-client PCC path. Auto-started via AppleScript with `open -a Terminal` fallback.
4. **Dual API surface**: Native `/fm/*` routes expose supported library operations. OpenAI `/v1/*` routes provide compatibility with existing tooling.
5. **Zod validation**: Runtime schemas define supported JSON inputs and TypeScript types; library-only cancellation uses `AbortSignal`.
6. **Serve-only generation**: Buffered generation, chat, streaming, and discovery use Terminal-hosted `fm serve`. Cancellation and serve errors propagate without switching transports. Standalone CLI calls are limited to quota usage, token counting, and serve bootstrap.

## Underlying CLI Reference

This package uses these commands from `/usr/bin/fm`:
- `fm serve --socket` — multi-client generation, chat, and discovery; system+pcc when Terminal-hosted
- `fm quota-usage` — PCC quota info
- `fm count-tokens` — token counting (system model only, `--quiet` for bare integer; supports `instructions`, `image`, and `transcript` options)

Other CLI capabilities, including `fm respond` and interactive `fm chat`, are not invoked by this package.

Models: `system` (on-device), `pcc` (Private Cloud Compute, default)
