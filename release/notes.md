**Relay by Bytical 0.3.1** — the phone app becomes a true VS Code sibling.

## New in this release

- **VS Code-style chat** — messages render as full-width rows with provider identity (✦ Copilot / Claude), just like the Copilot Chat panel; tools as status rows, hairline turn dividers, a proper chat input with the send button inside.
- **Brand-true colors** — the app now wears the product's cyan/violet, matching the icon, site, and extension.
- **Errors that speak human** — every error on every screen translates to a plain sentence with a next step. No more `spawn copilot ENOENT`: it now says "not installed on this computer" and how to fix it.

- **Markdown chat** — agent replies render properly: code blocks in mono cards with **tap-to-copy**, lists, headings, inline code.
- **Approve from the notification shade** — approval notifications now carry real **Allow / Skip** buttons; decisions are queued offline-safe and delivered the moment your laptop is reachable. Tap **Review** to jump into the session.
- **One-tap quick replies** — "Continue", "Run the tests", "Show me the diff", "Explain the changes" when a session is idle; "Fix it" after failures.
- **Instant-feel chat** — your messages appear the moment you hit send; an animated working indicator shows the agent is busy; chat lists render instantly from cache and refresh in the background.
- **Find anything** — chat history is grouped by day (Today / Yesterday / dates) with search across titles and projects.
- **No dead ends** — if no AI agent is installed on your computer, the app now tells you exactly which providers were checked, why each is unavailable, how to install one, with a one-tap recheck. Laptop chats that can't be continued explain themselves on tap.

## Companion updates (already live)

- **VS Code extension 0.2.5** — reconnects through controller restarts (no more stuck "offline"), friendly status states, self-explanatory menu, one-click controller updates when a new release ships, branded pairing panel with auto-regenerating codes.
- **Zero-dependency controller** — dashboard assets included; reload-safe on VS Code restarts.

## Get it

- **Android app (APK)** — `relay-by-bytical.apk` below, or [relay.bytical.ai/download](https://relay.bytical.ai/download) (always newest). Install over the old version — no uninstall needed.
- **VS Code extension** — [marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical](https://marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical) — *Set up this computer*, then *Pair phone*.
- **Standalone controller** (`relay-controller-standalone.tgz`) — extract, `node controller.mjs start`.

Phone ↔ laptop stays end-to-end encrypted; the relay only forwards ciphertext. No accounts — pairing is a QR handshake.
