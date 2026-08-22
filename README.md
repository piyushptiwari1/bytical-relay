# remote-dev-control

Mobile developer control plane for a local Windows dev machine. Planning docs live one level up
(`PLAN.md`, `RESEARCH-NOTES.md`, `IMPLEMENTATION-PLAN.md`) and will migrate into `/docs`.

## Status: S0 foundation slice

| Package | Purpose |
|---|---|
| `packages/shared` | Result type, UUIDv7 ids, decorrelated-jitter backoff, typed emitter, stable JSON |
| `packages/protocol` | Zod 4 message envelope, command/event definitions, version negotiation, binary frames |
| `packages/event-store` | Append-only journal (gap-free per-stream seq), replay cursors, idempotency, snapshots — memory + `node:sqlite` (WAL) |
| `packages/security` | Opaque token service, hash-chained audit log (E2EE/pairing arrive in S2) |

## Develop

```sh
pnpm install
pnpm test        # turbo run test (vitest per package)
pnpm typecheck
pnpm lint
```

Node ≥ 22.13 (dev on 24 LTS), pnpm 10 (versions via workspace catalog).

S0 demo gate: `packages/event-store/test/s0-gate.test.ts` — a command round-trips
client ⇄ controller with schema validation, sequence assignment, replay, and idempotent retry.
