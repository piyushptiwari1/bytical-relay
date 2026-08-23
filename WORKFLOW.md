# Working framework

Every feature slice follows this loop. No step is skipped; "it compiles" is never "it works".

## 1. Expectations first

Before writing code, list numbered, **user-visible** expectations (E1, E2, …):

> E1: This VS Code chat appears on the phone under "From your laptop", mapped to its project.
> E2: Tapping it opens the full transcript and can be continued.

Each expectation must be phrased so it can be checked live — from the phone or a probe — not
just by a unit test. State known platform boundaries explicitly (e.g. "VS Code panel is
read-only; phone chats continue via Copilot CLI").

## 2. Plan

- Files to touch, new protocol commands/events, data formats (verify real on-disk formats with
  a `tooling/peek-*.mjs` script before assuming).
- Risks + fallbacks (format drift → tolerant parse; slow path → cache).
- What the live probe for each expectation will be.

## 3. Implement

- Small slices, tolerant parsing of external formats, never block the ws event loop with
  heavy sync work (see the 7s chat-scan → `agent.list` timeout incident).
- Repo conventions: source-exports (`./src/index.ts`), `.ts` relative imports, CJS deps via
  `createRequire`, no BigInt/WASM in mobile code paths (Hermes).

## 4. Validate — in this order

```bash
pnpm typecheck                 # 13/13 packages
pnpm --filter <pkg> test       # unit/integration (vitest)
pnpm probe                     # LIVE probes against the running controller
```

`pnpm probe` (tooling/probe.mjs) simulates the phone over a plaintext local-token ws
connection. Token/port auto-read from `%LOCALAPPDATA%/rdc/config.json` / 8347.

| Command | What it proves |
| --- | --- |
| `pnpm probe` | status + chats + terminal suites (default) |
| `pnpm probe chats` | VS Code panel chats listed + project-mapped |
| `pnpm probe terminal` | terminal create → echo → snapshot → kill round-trip |
| `pnpm probe resume <native_id>` | live-continue a laptop chat via Copilot (consumes a Copilot turn; auto-archives unless `--keep`) |
| `pnpm probe archive <session_id>` | cleanup utility |

Add a suite to `tooling/probe.mjs` whenever a slice adds phone-visible behavior; the suite IS
the expectation list executable.

Controller restart procedure (required after controller-code changes — `tsx` dev has no reload):
kill the dev terminal, `pnpm --filter @rdc/desktop-controller dev`, wait for "controller ready",
then probe. Finish with a real phone check when UI changed (reload in Expo Go, Metro on 8082).

## 5. Commit

Conventional message per concern (`fix(vscode-chats): …`), tests green first.
Corporate hooks are slow — tests set `core.hooksPath=.git/hooks`.

## 6. Report

Reply with the expectation ledger (E# → PASS/FAIL + how it was verified live), any deviations
from plan, and exact user verification steps ("reload Expo Go → open project → …").

## Environment gotchas (Windows / git-bash)

- Direct `node script.mjs` works for ws probes; **stdio**-heavy scripts print
  "stdout is not a tty" → run via `cmd //c "node tooling\\x.mjs"`.
- Standalone TS execution: `cmd //c "node node_modules\\.pnpm\\tsx@<ver>\\node_modules\\tsx\\dist\\cli.mjs tooling\\x.mjs"`.
- Real Copilot CLI is `%APPDATA%/npm/copilot.cmd` (a VS Code shim shadows PATH and hangs).
- `pairing-e2e` may fail collection under the full parallel suite; rerun isolated before
  treating as a regression.
