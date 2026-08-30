# Contributing to Relay

Thanks for helping improve Relay by Bytical. This project handles developer machines, local agent
processes, and encrypted device connections, so small, reviewable changes are much more valuable
than broad rewrites.

## Before you begin

- Read [PRODUCT-DIRECTION.md](PRODUCT-DIRECTION.md) for product boundaries and current priorities.
- Read [SECURITY.md](SECURITY.md) before opening a vulnerability report.
- Check existing issues before beginning a feature or behavior change.
- Do not include credentials, access tokens, local databases, pairing grants, device keys, or real
  customer/project files in an issue, test, commit, or screenshot.

## Local setup

```sh
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm lint
```

The controller and mobile app are developed separately:

```sh
pnpm --filter @rdc/desktop-controller dev
pnpm --filter @rdc/mobile start
```

For changes visible to a paired device, run the live controller probe after restarting the
controller:

```sh
pnpm probe
```

## Pull requests

1. Keep each pull request focused on one user-visible outcome or one security concern.
2. Add or update tests for behavior changes. Add a live probe when the change affects phone-visible
   controller behavior.
3. Run `pnpm typecheck`, `pnpm test`, and `pnpm lint` before requesting review.
4. Explain the user-visible effect, validation performed, security impact, and any known limitation.
5. Do not combine formatting-only changes with unrelated behavior changes.

## Ownership boundaries

| Surface | Primary concern |
| --- | --- |
| `packages/protocol` | Compatible wire schemas and versioning |
| `packages/security` | Pairing, encryption, authorization, audit |
| `packages/event-store` and `packages/transport` | Replay, sequencing, idempotency, reconnect |
| `apps/desktop-controller` | Windows lifecycle and local machine authority |
| `apps/mobile` | Mobile control, offline states, notifications, accessibility |
| `extensions/vscode` | Official VS Code API integration only |
| `apps/site` | Relay by Bytical public communication |

Changes spanning multiple boundaries should include a brief design note in the pull request.

## Design and safety principles

- The laptop is authoritative; the phone is a control and monitoring surface.
- Use structured provider APIs and ACP where available. Do not scrape agent terminal UIs.
- Preserve replayability and idempotency across controller or network interruptions.
- Prefer direct local transport, make remote transport explicit, and never log secrets.
- Do not use undocumented VS Code or provider internals as product dependencies.