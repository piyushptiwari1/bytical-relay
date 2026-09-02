**Relay by Bytical 0.2.0** — control your dev machine and AI coding agents from your phone.

## New in this release

- **Choose your agent** — Relay now speaks to **GitHub Copilot** and **Claude Code**. When both are installed on your laptop, the composer shows a provider picker; sessions start with whichever you tap.
- **Zero-dependency laptop setup** — the VS Code extension downloads a self-contained controller and runs it on VS Code's own runtime. No Node, no Git, no package manager needed on the machine.
- **Survives VS Code restarts** — reloading or restarting VS Code now reattaches to the running controller; your agent sessions keep going uninterrupted (extension 0.2.1).
- **Field hardening (Linux)** — snap-packaged VS Code quirks fixed, giant-repo file-watch limits degrade gracefully instead of crashing, and the owner dashboard now works in the standalone controller.
- **Auto keep-awake** — the laptop stays awake while agents are working or your phone is connected, and releases the hold a few minutes after things go quiet.
- **Job profiles** — start sessions as **Build**, **Plan**, or **Ask**; Plan and Ask are enforced read-only by the controller.
- **Feedback everywhere** — 1–5 ★ reviews, feature ideas, and bug reports from the app, website, and extension.

## What's inside

- **Android app (APK)** — `relay-by-bytical.apk` below, or grab it any time from [relay.bytical.ai/download](https://relay.bytical.ai/download) (always the newest build). In-app update banner announces future releases.
- **VS Code extension** — [marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical](https://marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical) — 2 clicks: *Set up this computer*, then *Pair phone*.
- **Standalone controller** (`relay-controller-standalone.tgz`) — for CLI users: extract and `node controller.mjs start`.
- End-to-end encrypted phone↔laptop channel — the relay only ever forwards ciphertext.
- Agent chat, approvals from your lock screen, scoped terminals, git status, push notifications, offline outbox.
- Re-pairing keeps one device row per phone: keys and token rotate, the old credential dies instantly.

## Upgrading

Install the new APK over the old one (no uninstall needed). If your laptop extension is older than 0.2.1, let it auto-update, then run **Relay: Set up / update this computer** once to refresh the controller.
