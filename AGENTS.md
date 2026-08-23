# Agent instructions

Follow [WORKFLOW.md](WORKFLOW.md) for every feature slice: list numbered user-visible
expectations → plan → implement → validate (`pnpm typecheck`, package tests, then **live**
`pnpm probe` against the running controller) → commit → report the expectation ledger.

Key facts:

- pnpm 10 workspaces + Turborepo; packages export `./src/index.ts`; `.ts` relative imports.
- Mobile is Expo/Hermes: no WASM, no BigInt; crypto is @noble (`rdc/e2ee/v2`).
- Controller dev runs under `tsx` (no reload — restart after controller changes); port 8347.
- External formats (VS Code chatSessions, Copilot session-store.db) are unstable: parse
  tolerantly, verify with `tooling/peek-*.mjs` scripts, never crash on drift.
- Windows/git-bash gotchas and probe usage: see WORKFLOW.md "Environment gotchas".
