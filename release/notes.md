**Relay by Bytical 0.3.3** — your chats, where you actually work.

## New in this release

- **Parent-folder chats show up in every project** — if you chat in VS Code with an umbrella folder open (one folder containing several repos), those chats now appear inside each contained project's view on the phone, not hidden under an arbitrary one.
- **Field diagnostics** — pairing failures and app crashes now report anonymous breadcrumbs (event + reason + version, never your code or prompts) to our own server, so problems get fixed before you finish describing them. Opt-out on the controller with RDC_NO_TELEMETRY=1.
- **Clearer guidance** — the app explains that phone sessions need the Copilot CLI (one click from the VS Code sidebar: “Install Copilot CLI”), that chats import from each computer's own VS Code history, and pull-to-refresh everywhere it matters.

## Companion updates (already live)

- **VS Code extension 0.2.9** — one-click Copilot CLI installer; controller updates itself silently when idle.
- **Controller** — remote access works out of the box for every install (no credentials to configure); Linux chat scanning covers snap/flatpak variants.

## Get it

- **Android app (APK)** — `relay-by-bytical.apk` below, or [relay.bytical.ai/download](https://relay.bytical.ai/download). Install over the old version — pairings are kept.
- **VS Code extension** — [marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical](https://marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical).
- **Standalone controller** (`relay-controller-standalone.tgz`) — extract, `node controller.mjs start`.
