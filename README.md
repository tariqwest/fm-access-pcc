# fm-access-pcc

TypeScript library and HTTP server for Apple Foundation Models on macOS — **system** (on-device) and **pcc** (Private Cloud Compute).

**Validated PCC path:** Terminal-hosted `fm serve --socket`. External clients (this library and the TCP server) call the serve Unix socket. A PTY or direct non-Terminal `fm respond --model pcc` does **not** unlock PCC.

## Install

```bash
bun add fm-access-pcc
```

Happy path installs **cua-driver** (for auto-starting Terminal-hosted serve) via postinstall. Skip with:

```bash
FM_ACCESS_PCC_SKIP_CUA_DRIVER_POSTINSTALL=1 bun add fm-access-pcc
```

## Requirements

- macOS 27+ with `/usr/bin/fm`
- Bun >= 1.0.0
- For PCC: Terminal-hosted `fm serve` (auto-started by default) or share an existing socket

## Library usage

```typescript
import { respond, createChatSession, getAvailableModels, countTokens } from 'fm-access-pcc';

const result = await respond('What is Swift?', { model: 'pcc' });
console.log(result.text, result.backend); // backend: 'fm-serve' | 'fm' | 'lab-bridge'

for await (const chunk of respond('Explain async/await', { stream: true, model: 'system' })) {
  process.stdout.write(chunk.text);
}

const chat = await createChatSession({ model: 'pcc', instructions: 'Be concise' });
const reply = await chat.send('Hello');
await chat.close();

const models = await getAvailableModels();
const { count } = await countTokens('Hello world');
```

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

1. Ensure `cua-driver` (postinstall / first use)
2. Write `~/.config/fm-access-pcc/start-fm-serve.command`
3. Launch Terminal via `cua-driver call launch_app` (fallback: `open -a Terminal`)
4. Wait for `GET /health` on the Unix socket

Manual:

```bash
mkdir -p ~/.config/fm-access-pcc
# In Terminal.app:
fm serve --socket ~/.config/fm-access-pcc/fm.sock
```

Disable auto-start: `FM_ACCESS_PCC_AUTO_SERVE=0`.

Share a socket with fm-acp:

```bash
export FM_ACCESS_PCC_SERVE_SOCK="$HOME/.config/fm-acp/fm.sock"
```

### Anti-patterns (do not use for PCC)

- PTY-wrapped `fm respond --model pcc`
- Background / non-Terminal `fm serve`
- `osascript` `do script` to launch serve
- Assuming a helper process under Terminal makes child `fm respond` PCC-capable

## Environment

| Variable | Description |
|---|---|
| `FM_ACCESS_PCC_SERVE_SOCK` | `fm serve --socket` path (default `~/.config/fm-access-pcc/fm.sock`) |
| `FM_ACCESS_PCC_AUTO_SERVE` | Default **on**. `0`/`false` disables auto Terminal launch |
| `FM_ACCESS_PCC_AUTO_SERVE_TIMEOUT_MS` | Wait for serve health (default `12000`) |
| `FM_ACCESS_PCC_SERVE_LAUNCHER` | Path to `start-fm-serve.command` |
| `FM_ACCESS_PCC_ENSURE_CUA_DRIVER` | Default **on**. Install cua-driver when missing |
| `FM_ACCESS_PCC_SKIP_CUA_DRIVER_POSTINSTALL` | `1` skips install-time ensure |
| `FM_ACCESS_PCC_LAB_BRIDGE` | Default **on** probe of Lab `connection.json` if present |
| `FM_BIN` / `FM_BIN_PATH` | Path to `fm` |
| `CUA_DRIVER_BIN` / `CUA_DRIVER_PATH` | cua-driver binary |
| `CUA_DRIVER_INSTALL_URL` | Installer URL |
| `AFM_BRIDGE_DESCRIPTOR` | Lab bridge descriptor path |

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
  transport.ts       # serve → lab-bridge → direct fm
  fm-serve.ts        # HTTP over Unix socket
  serve-bootstrap.ts # Terminal auto-start (cua-driver / open -a)
  cua-driver.ts
  respond.ts / chat.ts / models.ts
src/server/          # Hono adapter
```

Research notes: `.agents/research/pcc-matrix-results.md`, `.agents/research/afm-lab-pcc-findings.md`.

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
              /usr/bin/fm  (+ optional afm / Lab bridge)
```

### Parent / consumer

| Project | Relation |
|---|---|
| **[fm-server](https://github.com/tariqwest/fm-server)** | Higher-level OpenAI-compatible HTTP server/CLI for Apple FM. Routes **`pcc`** through **fm-access-pcc** and **`system`** through in-process FFI via javascript-apple-fm-sdk. Treat as the usual “drop-in server” parent of this library. |

### Sibling (same FM / PCC surface, different host protocol)

| Project | Relation |
|---|---|
| **[fm-acp](https://github.com/tariqwest/fm-acp)** | ACP stdio adapter for the same Terminal-hosted `fm serve` + PCC research. Overlapping bootstrap (`cua-driver`, serve launcher, Lab bridge). Prefer **fm-acp** inside ACP hosts (Zed, etc.); prefer **this package** for library imports and a plain HTTP/OpenAI TCP API. Sockets can be shared via `FM_ACCESS_PCC_SERVE_SOCK` / `FM_ACP_SERVE_SOCK`. |
| **[oz-acp](https://github.com/tariqwest/oz-acp)** | Sibling ACP adapter pattern for Warp’s `oz` CLI (not Apple FM). Same “host protocol adapter” shape as fm-acp, different backend. |

### Child / lower layer

| Project | Relation |
|---|---|
| **macOS `/usr/bin/fm`** | System CLI this package wraps (`respond`, `serve --socket`, `available`, …). Required runtime; not a separate repo. |
| **[javascript-apple-fm-sdk](https://github.com/tariqwest/javascript-apple-fm-sdk)** | On-device `SystemLanguageModel` bindings (FFI). Complementary path used by **fm-server** for `system`; this package reaches on-device mainly via `fm` / serve rather than the SDK. |

### Overlapping / inspiration

| Project | Relation |
|---|---|
| **[acp-to-api](https://github.com/tariqwest/acp-to-api)** | OpenAI-compatible REST front for local **ACP** agents. Same “expose agent-ish backends as `/v1`” idea; backends are ACP CLIs, not `fm`. |
| **[prompt-to-api](https://github.com/tariqwest/prompt-to-api)** | Sibling of acp-to-api for one-shot print-mode AI CLIs. |
| **[promptpipe](https://github.com/tariqwest/promptpipe)** | Unix-style prompt/stdin plumbing for coding CLIs; inspiration for thin, composable agent I/O rather than full harnesses. |
| **[acp-router](https://github.com/tariqwest/acp-router)** | LiteLLM-oriented ACP routing; related agent-gateway ecosystem, not FM-specific. |
| **Apple `fm serve`** | Built-in OpenAI-shaped local server. Inspiration and production transport: when **Terminal-hosted**, it is the validated multi-client PCC path this package clients. |
| **Foundation Lab / `afm`** | Community Lab app + CLI; historical Agent Bridge (`connection.json`) is an optional secondary PCC candidate (see research notes). Homebrew `afm` alone is on-device-oriented. |
| **[Cua cua-driver](https://cua.ai/driver/install.sh)** | Used to auto-launch Terminal for PCC-capable `fm serve` (same happy path as fm-acp). |

### When to use what

- **Importable API / small Hono service for FM only** → this package (`fm-access-pcc`)
- **Unified FM HTTP server with FFI system + PCC** → [fm-server](https://github.com/tariqwest/fm-server)
- **Apple FM inside an ACP IDE** → [fm-acp](https://github.com/tariqwest/fm-acp)
- **Warp Oz inside ACP** → [oz-acp](https://github.com/tariqwest/oz-acp)
- **OpenAI HTTP in front of other local agents/CLIs** → [acp-to-api](https://github.com/tariqwest/acp-to-api) / [prompt-to-api](https://github.com/tariqwest/prompt-to-api)

## License

MIT
