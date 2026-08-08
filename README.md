# fm-access-PCC

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

## License

MIT
