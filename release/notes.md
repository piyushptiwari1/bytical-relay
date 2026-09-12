**Relay by Bytical 0.3.5** — a home that feels like chat, and pairing that connects.

## Fix you'll feel first

- **Paired but “unreachable” — fixed.** Phones that paired through the relay (office Wi-Fi, firewalls, different networks) never received the relay credentials and could only try the laptop's Wi-Fi address. The pairing grant now carries them, so the phone connects through the relay right after pairing. **Re-pair each computer once after installing** — the fix travels in the pairing itself.

## New home screen

- **Conversations first** — the home is now a single list of your chats across all computers, newest first, with a **“Needs you”** section on top when an agent is waiting for an answer.
- **“＋ Ask your agents…”** — one bar at the bottom starts a new conversation; pick the computer and project as chips, not a journey through screens. It remembers your last choice.
- **Computers moved out of the way** — a **Computers ›** screen holds pairing, retry, feedback and update checks. A computer only appears on the home when something's wrong, with a one-tap Retry.
- **Human words** — “needs you”, “working”, “done” instead of status codes.

## Under the hood

- Phone reports *why* a connection failed (timeout / refused / auth — never addresses or tokens) so problems get diagnosed remotely.
- Everything from 0.3.3: umbrella-folder chats in every project, field diagnostics, Copilot CLI guidance, pull-to-refresh.

## Companion updates (already live)

- **VS Code extension 0.2.10** — checks hourly for controller updates (was 12 h), so long-running VS Code windows pick up fixes fast.
- **Controller** — relay link self-heals after relay restarts or network drops (client-side heartbeat); relay rejections are logged; pairing grants carry relay tickets.
- **Relay infrastructure** — pinned server image (no more silent instance replacement), diagnostics database backed up to S3 and restored automatically.

## Get it

- **Android app (APK)** — `relay-by-bytical.apk` below, or [relay.bytical.ai/download](https://relay.bytical.ai/download). Install over the old version — pairings are kept.
- **VS Code extension** — [marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical](https://marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical).
- **Standalone controller** (`relay-controller-standalone.tgz`) — extract, `node controller.mjs start`.
