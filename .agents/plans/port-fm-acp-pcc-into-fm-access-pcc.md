# Port fm-acp PCC innovations into fm-access-pcc

## Problem

`fm-access-pcc` currently assumes PCC can be unlocked by wrapping `fm respond` / `fm chat` (especially via `node-pty`). Research and matrix testing in `~/Developer/fm-acp` proved that is wrong for multi-client use:

- Direct non-Terminal `fm respond --model pcc` fails with Terminal-ancestry errors.
- A PTY alone does **not** unlock PCC.
- Spawning `fm respond` from a Terminal-hosted helper still fails for the child.
- Background / non-Terminal `fm serve` serves **system only**.
- **Validated PCC path:** Terminal-hosted `fm serve --socket`; external clients then get system + pcc over HTTP/UDS.

fm-access-pcc's README and original plan still claim “`fm serve` cannot route to PCC,” which is outdated: PCC works when serve itself is started under Terminal.app. The library should adopt that model as the primary transport.

## Current state

### fm-access-pcc (today)

- `src/core/respond.ts`: direct spawn for `system`; PTY spawn for `pcc`.
- `src/core/chat.ts`: PTY `fm chat` session registry.
- `src/core/models.ts`: parses `fm available` from the current process context (PCC usually false outside Terminal).
- Server is a thin Hono adapter over those core APIs.
- No serve socket client, no Terminal auto-start, no cua-driver, no Lab bridge.

### fm-acp innovations to port

| Innovation | Where in fm-acp | Value for fm-access-pcc |
|---|---|---|
| Terminal-hosted `fm serve --socket` as primary PCC transport | `src/backends/fm-serve.ts` | Multi-client OpenAI-compatible access to system+pcc |
| Auto bootstrap via cua-driver `launch_app` Terminal + `additional_arguments`, fallback `open -a Terminal` | `src/serve-bootstrap.ts`, `src/cua-driver.ts` | Zero-touch happy path when server starts |
| Health-driven availability (`/health` models + reasons) | `fmServeAvailable` | Accurate PCC availability without lying from non-Terminal `fm available` |
| Backend routing with late bootstrap + ordered fallbacks | `src/backends/resolve.ts` | Resilient `respond` / chat completions |
| Optional Lab Agent Bridge client (`connection.json` + bearer loopback) | `src/backends/lab-bridge.ts` | Secondary entitlement-based PCC if upstream re-ships |
| Private config dirs (0700) + launcher script under XDG config | `private-fs.ts`, serve launcher | Safe shared socket/launcher state |
| Explicit anti-patterns: no osascript `do script`; no helper-as-PCC; no PTY-as-PCC | plans + AGENTS.md | Correct docs and less dead code |

Do **not** port ACP-only concerns (stdio NDJSON, session store for ACP, terminal helper protocol) into fm-access-pcc.

## Target architecture

```text
Library / HTTP server
  │
  ├─ transport resolve (auto)
  │    1. Terminal-hosted fm serve --socket   ← primary (system + pcc)
  │    2. Lab Agent Bridge (optional)         ← secondary PCC candidate
  │    3. direct /usr/bin/fm respond|…        ← system + CLI-only features
  │
  ├─ ensureFmServe()
  │    health? → ok
  │    else write ~/.config/fm-access-pcc/start-fm-serve.command
  │    cua-driver launch_app Terminal + args → wait /health
  │    else open -a Terminal launcher → wait /health
  │
  └─ public API unchanged at call sites where possible:
       respond / chat completions / available / quota / token-count
```

Config root defaults to `~/.config/fm-access-pcc/` (not `fm-acp`) so packages do not fight over sockets. Optional env override to share fm-acp's socket when both run on one machine.

## Proposed changes

### 1. New core transport modules

Add under `src/core/` (library-first, no Hono):

- `config.ts` — paths/env: `FM_ACCESS_PCC_SERVE_SOCK` (default `~/.config/fm-access-pcc/fm.sock`), `FM_ACCESS_PCC_AUTO_SERVE`, `FM_ACCESS_PCC_ENSURE_CUA_DRIVER`, `FM_ACCESS_PCC_SERVE_LAUNCHER`, `FM_BIN`/`FM_BIN_PATH`, Lab bridge descriptor envs. Allow opt-in share with fm-acp via `FM_ACCESS_PCC_SERVE_SOCK=$FM_ACP_SERVE_SOCK` or a documented common path.
- `private-fs.ts` — port minimal 0700/0600 helpers from fm-acp.
- `fm-serve.ts` — HTTP/1.1 over Unix socket: `fmServeHealth`, `fmServeChatCompletion` (stream + non-stream), SSE parse. Port from `fm-acp/src/backends/fm-serve.ts` with fm-access-pcc types/errors.
- `cua-driver.ts` — resolve/install official CLI (not npm SDK). Port from fm-acp; keep install optional/default-on with kill switch.
- `serve-bootstrap.ts` — write launcher script, `ensureFmServe()` with cua-driver then `open -a Terminal`. **Do not** use osascript `do script`.
- `lab-bridge.ts` (optional phase) — descriptor reader + bearer HTTP client; no claim of PCC unless health advertises it. Speculative until Lab re-ships bridge host.
- `transport.ts` — single resolver used by library APIs:
  - `ensureTransport()` / `getModelAvailability()`
  - `runRespond(prompt, options)` chooses serve vs direct fm
  - Prefer serve for both `system` and `pcc` when healthy
  - For `pcc`, never treat PTY `fm respond` as success path; if serve/bridge unavailable, fail with actionable error pointing at Terminal-hosted serve
  - For CLI-only features serve lacks (`token-count`, `quota-usage`, schema/image if not supported by serve), keep direct `fm` and document model constraints

### 2. Rework `respond` and multi-turn

**`respond.ts`**

- Remove PCC→PTY special case as the production path.
- Delegate to transport: serve chat completions when transport is serve; else direct spawn for system (and any non-PCC fallbacks).
- Map options:
  - `model`, `instructions`, `stream`, history/transcript → serve messages array when using serve
  - `greedy` / temperature: best-effort map if serve ignores unknown fields; keep CLI flags on direct path
  - `schema` / `image`: prefer direct `fm respond` when requested **and** model is runnable that way; if model is `pcc` and only serve can run PCC, either (a) reject with clear error until serve supports the feature, or (b) document limitation. Default: clear error rather than silent wrong path.
- Surface `backend: 'fm-serve' | 'fm' | 'lab-bridge'` on result (additive field) for debugging; keep `text` stable.

**`chat.ts`**

- Prefer stateless multi-turn over serve: client/server holds message history and posts full messages to `/v1/chat/completions` (same as fm-acp session history).
- Keep PTY `fm chat` only as optional legacy/on-device path, or quarantine behind `transport: 'pty-chat'` — do not market it as PCC.
- Session API (`createChatSession` / `send` / `close`) can remain; implementation becomes in-memory history + transport calls instead of PTY by default.

### 3. Availability, health, OpenAI routes

- `getAvailableModels()`: prefer `fm serve` `/health` after ensure; merge reasons (`available`, optional `reason`, `source`). Fall back to `fm available` for system-only truth when serve down.
- Native `/health`: report wrap status **and** serve socket health + model list (breaking change to shape is OK if versioned or additive fields).
- OpenAI `/v1/models` and `/v1/chat/completions`: route through transport so PCC works for external HTTP clients the same way curl→serve does in the matrix.
- On server `start()`, call `ensureFmServe()` once (log to stderr); lazy ensure on first PCC request as well.

### 4. Package / ops surface

- Optional dependency/runtime: document `cua-driver` as happy-path requirement (install script URL), same caveats as fm-acp (no real npm CLI package).
- Scripts: `ensure:cua-driver`, optional `postinstall` (default on with skip env), mirroring fm-acp.
- Env table in README; default auto-serve ON with `FM_ACCESS_PCC_AUTO_SERVE=0` kill switch.
- Consider Unix socket **proxy mode** later (out of scope unless needed): wrap could reverse-proxy to serve socket; for v1, wrap owns TCP `:8000` and fans out to serve UDS internally.

### 5. Docs and project identity

Update `README.md`, `AGENTS.md`, and replace/supersede stale claims in `.agents/plans/exposing-macos-fm-client-with-service.md`:

- Correct “why not fm serve”: serve **does** PCC when Terminal-hosted; wrap still adds library API, TCP service, quota/token-count, richer native routes, auto-bootstrap.
- Document validated operator flow and anti-patterns (PTY≠PCC, helper≠PCC).
- Cross-link fm-acp research: `.agents/research/` includes `afm-lab-pcc-findings.md` and `pcc-matrix-results.md`.
- Keep library-first architecture; server remains thin adapter.

### 6. Tests (TDD, mocked)

Port/adapt unit tests from fm-acp patterns; keep vitest + mocked spawn/http:

- `fm-serve.test.ts` — health parse, non-stream completion, SSE assembly, error 503 Terminal message.
- `serve-bootstrap.test.ts` — already running; cua path; open -a fallback; auto disabled; launcher script contents.
- `cua-driver.test.ts` — resolve candidates; ensure skipped/installed/failed.
- `transport.test.ts` — pcc prefers serve; pcc fails closed without serve; system falls back to direct fm; no backend switch after stream emit starts.
- Update `respond.test.ts` / `openai.test.ts` / `models.test.ts` for new routing; remove expectations that PTY is used for pcc.
- Integration smoke (manual/docs): Terminal serve health system+pcc; external `bun run start` + curl pcc completion.

### 7. Explicit non-goals

- Do not depend on `fm-acp` as a runtime package (avoid circular/link packaging); copy/adapt small modules.
- Do not reintroduce Terminal helper socket protocol as primary PCC.
- Do not parent-spoof or process-inject to fake Terminal ancestry.
- Do not claim Lab bridge PCC until descriptor+host validated on device.
- Do not parse interactive `fm chat` TUI for the default path.

## Migration / compatibility

- Semver: treat as **minor** if API additive (`backend` field, richer health); **major** if removing PTY default for chat or changing `/health` shape incompatibly. Prefer additive health + default transport change with changelog callout (behavior fix for pcc).
- Callers using `model: 'pcc'` should start working when auto-serve succeeds; previously they mostly failed outside Terminal despite PTY.
- `node-pty`: demote to optional peerDep or keep only for legacy chat flag; goal is primary path has **zero** native addon requirement (aligns with fm-acp decision).

## Implementation order

1. Config + private-fs + fm-serve client + tests
2. cua-driver + serve-bootstrap + tests
3. transport resolver wired into `respond` + `getAvailableModels`
4. Server start ensure + OpenAI/native route behavior + health
5. Chat session → history + serve (legacy PTY optional)
6. Optional lab-bridge behind flag
7. Docs/AGENTS/README + copy research notes
8. Manual PCC smoke on macOS 27 with Terminal-hosted serve

## Success criteria

- From a non-Terminal agent/shell, `respond('ping', { model: 'pcc' })` succeeds after auto-start (or clear error if auto-serve disabled and serve down).
- `/v1/chat/completions` with `model: pcc` returns content via wrap TCP server while serve runs under Terminal.
- `/health` or availability reports pcc available only when serve (or bridge) actually advertises it.
- No production code path claims PTY unlocks PCC.
- `bun run test` and `bun run typecheck` pass; library still importable without starting HTTP.

## Source references (fm-acp)

- `~/Developer/fm-acp/src/backends/fm-serve.ts`
- `~/Developer/fm-acp/src/serve-bootstrap.ts`
- `~/Developer/fm-acp/src/cua-driver.ts`
- `~/Developer/fm-acp/src/backends/resolve.ts`
- `~/Developer/fm-acp/src/backends/lab-bridge.ts`
- `~/Developer/fm-acp/.agents/plans/pcc-matrix-results.md`
- `~/Developer/fm-acp/.agents/research/afm-lab-pcc-findings.md`
- Local copies: `.agents/research/afm-lab-pcc-findings.md`, `.agents/research/pcc-matrix-results.md`
