# fm-access-pcc

TypeScript library and HTTP server for Apple Foundation Models on macOS — **system** (on-device) and **pcc** (Private Cloud Compute).

**Validated PCC path:** Terminal-hosted `fm serve --socket`. External clients (this library and the TCP server) call the serve Unix socket. Generation and chat never invoke direct `fm respond` or PTY-backed `fm chat`.

## Install

```bash
bun add fm-access-pcc
```

## Requirements

- macOS 27+ with `/usr/bin/fm`
- Bun >= 1.0.0
- For PCC: Terminal-hosted `fm serve` (auto-started by default) or share an existing socket

## Library usage

```typescript
import { respond, createChatSession, getAvailableModels, countTokens } from 'fm-access-pcc';

const result = await respond('What is Swift?', { model: 'pcc' });
console.log(result.text, result.backend); // backend: 'fm-serve'

for await (const chunk of respond('Explain async/await', { stream: true, model: 'system' })) {
  process.stdout.write(chunk.text);
}

const chat = await createChatSession({ model: 'pcc', instructions: 'Be concise' });
const reply = await chat.send('Hello');
await chat.close();

const models = await getAvailableModels();
const { count } = await countTokens('Hello world');
```

## Transport behavior

- Buffered generation, history-backed chat, streaming, and model discovery use Terminal-hosted `fm serve` exclusively.
- Serve errors propagate directly; generation fails explicitly for both `system` and `pcc` when the socket is unavailable.
- Chat sessions store conversation history in memory. Closing a session discards that state; there is no chat subprocess.
- Standalone CLI calls remain only for quota usage, token counting, and starting `fm serve`.

**Generation API migration:** `respond()` supports `model`, `instructions`, `stream`, and `history`, plus library-only `signal` cancellation. CLI-only generation options and direct helper exports have been removed. Chat options are now only `model` and `instructions`; PTY transport selection and `resume` are no longer supported. Token-count options are unchanged.

## Server usage

```typescript
import { createServer } from 'fm-access-pcc/server';

const server = createServer({ port: 8000 });
await server.start(); // ensures Terminal-hosted fm serve by default
```

```bash
bun run start
```

### Native API

```
POST   /fm/respond
POST   /fm/chat
DELETE /fm/chat/:session_id
GET    /fm/models/available
GET    /fm/quota
POST   /fm/token-count
GET    /health                 # includes serve socket health + models
```

### OpenAI-compatible API

```
GET    /v1/models
POST   /v1/chat/completions
```

## PCC operator flow

Default **auto-serve** (ON):

1. Write `~/.config/fm-access-pcc/start-fm-serve.command`.
2. Launch it in Terminal using AppleScript, falling back to `open -a Terminal`.
3. Wait for `GET /health` on the Unix socket.

macOS may request Automation permission to control Terminal. Both methods worked in an isolated PCC test, but availability can vary by environment. Concurrent starts for the same socket are coalesced within one process; separate processes are not coordinated.

Manual:

```bash
mkdir -p ~/.config/fm-access-pcc
# In Terminal.app:
fm serve --socket ~/.config/fm-access-pcc/fm.sock
```

Disable auto-start: `FM_ACCESS_PCC_AUTO_SERVE=0`.

**Bootstrap methods:** A successful `ensureFmServe` launch reports `method: 'applescript'` or `'open-terminal'`. No third-party Terminal automation dependency is required.

Share a socket with fm-acp:

```bash
export FM_ACCESS_PCC_SERVE_SOCK="$HOME/.config/fm-acp/fm.sock"
```

### Unsupported PCC launch contexts

These research findings are not package fallbacks:

- PTY-wrapped `fm respond --model pcc`
- Background / non-Terminal `fm serve`
- Running `fm serve` with `nohup` and redirected standard streams: in testing, the server survived closing its Terminal window, but PCC was unavailable even before the window closed. Keep the validated foreground Terminal session open for PCC.
- Assuming a helper process under Terminal makes child `fm respond` PCC-capable

## Environment

| Variable | Description |
|---|---|
| `FM_ACCESS_PCC_SERVE_SOCK` | `fm serve --socket` path (default `~/.config/fm-access-pcc/fm.sock`) |
| `FM_ACCESS_PCC_AUTO_SERVE` | Default **on**. `0`/`false` disables auto Terminal launch |
| `FM_ACCESS_PCC_AUTO_SERVE_TIMEOUT_MS` | Wait for serve health (default `12000`) |
| `FM_ACCESS_PCC_SERVE_LAUNCHER` | Path to `start-fm-serve.command` |
| `FM_BIN` / `FM_BIN_PATH` | Path to `fm` for serve bootstrap, quota usage, and token counting |

## Development

```bash
bun install
bun run test
bun run typecheck
bun run build
```

## Architecture

```
src/core/
  transport.ts       # generation, chat, streaming, and discovery over fm serve
  fm-serve.ts        # HTTP over Unix socket
  serve-bootstrap.ts # Terminal auto-start (AppleScript / open -a)
  respond.ts / chat.ts / models.ts
src/server/          # Hono adapter
```

Research notes: `.agents/research/pcc-matrix-results.md`.

## Related projects

`fm-access-pcc` sits in a small stack of Apple FM / agent-bridge tools. Rough roles:

```text
                    ┌─────────────────────────────┐
                    │  Hosts / OpenAI clients     │
                    │  (apps, ACP IDEs, curl)     │
                    └─────────────┬───────────────┘
           ┌──────────────────────┼──────────────────────┐
           ▼                      ▼                      ▼
   ┌───────────────┐    ┌─────────────────┐    ┌──────────────────┐
   │ fm-acp        │    │ fm-server       │    │ acp-to-api /     │
   │ (ACP stdio)   │    │ (HTTP gateway)  │    │ prompt-to-api    │
   └───────┬───────┘    └────────┬────────┘    └──────────────────┘
           │  shared PCC ideas   │ uses this package for `pcc`
           ▼                     ▼
   ┌────────────────────────────────────────────┐
   │ fm-access-pcc  (this repo)                 │
   │ library + /fm + /v1 over Terminal fm serve │
   └────────────────────┬───────────────────────┘
                        ▼
                   /usr/bin/fm
```

### Parent / consumer

| Project | Relation |
|---|---|
| **[fm-server](https://github.com/tariqwest/fm-server)** | Higher-level OpenAI-compatible HTTP server/CLI for Apple FM. Routes **`pcc`** through **fm-access-pcc** and **`system`** through in-process FFI via javascript-apple-fm-sdk. Treat as the usual “drop-in server” parent of this library. |

### Sibling (same FM / PCC surface, different host protocol)

| Project | Relation |
|---|---|
| **[fm-acp](https://github.com/tariqwest/fm-acp)** | ACP stdio adapter for the same Terminal-hosted `fm serve` + PCC research. Shared serve-launcher concepts. Prefer **fm-acp** inside ACP hosts (Zed, etc.); prefer **this package** for library imports and a plain HTTP/OpenAI TCP API. Sockets can be shared via `FM_ACCESS_PCC_SERVE_SOCK` / `FM_ACP_SERVE_SOCK`. |
| **[oz-acp](https://github.com/tariqwest/oz-acp)** | Sibling ACP adapter pattern for Warp’s `oz` CLI (not Apple FM). Same “host protocol adapter” shape as fm-acp, different backend. |

### Child / lower layer

| Project | Relation |
|---|---|
| **macOS `/usr/bin/fm`** | System CLI used for `serve --socket`, `quota-usage`, and `count-tokens`. Generation and chat use the serve API, not direct CLI commands. Required runtime; not a separate repo. |
| **[javascript-apple-fm-sdk](https://github.com/tariqwest/javascript-apple-fm-sdk)** | On-device `SystemLanguageModel` bindings (FFI). Complementary path used by **fm-server** for `system`; this package reaches on-device through `fm serve` rather than the SDK. |

### Overlapping / inspiration

| Project | Relation |
|---|---|
| **[acp-to-api](https://github.com/tariqwest/acp-to-api)** | OpenAI-compatible REST front for local **ACP** agents. Same “expose agent-ish backends as `/v1`” idea; backends are ACP CLIs, not `fm`. |
| **[prompt-to-api](https://github.com/tariqwest/prompt-to-api)** | Sibling of acp-to-api for one-shot print-mode AI CLIs. |
| **[promptpipe](https://github.com/tariqwest/promptpipe)** | Unix-style prompt/stdin plumbing for coding CLIs; inspiration for thin, composable agent I/O rather than full harnesses. |
| **[acp-router](https://github.com/tariqwest/acp-router)** | LiteLLM-oriented ACP routing; related agent-gateway ecosystem, not FM-specific. |
| **Apple `fm serve`** | Built-in OpenAI-shaped local server. Inspiration and production transport: when **Terminal-hosted**, it is the validated multi-client PCC path this package clients. |

### When to use what

- **Importable API / small Hono service for FM only** → this package (`fm-access-pcc`)
- **Unified FM HTTP server with FFI system + PCC** → [fm-server](https://github.com/tariqwest/fm-server)
- **Apple FM inside an ACP IDE** → [fm-acp](https://github.com/tariqwest/fm-acp)
- **Warp Oz inside ACP** → [oz-acp](https://github.com/tariqwest/oz-acp)
- **OpenAI HTTP in front of other local agents/CLIs** → [acp-to-api](https://github.com/tariqwest/acp-to-api) / [prompt-to-api](https://github.com/tariqwest/prompt-to-api)

## License

MIT
