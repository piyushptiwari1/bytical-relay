First public alpha of **Relay by Bytical** — control your dev machine and AI coding agents from your phone.

## New in this release

- **One-tap install & update**: [relay.bytical.ai/download](https://relay.bytical.ai/download) always serves the newest APK, and the in-app update banner downloads directly.
- **Feedback everywhere**: review (1–5 ★), feature ideas, update requests, and bug reports — from the app, the website, and the VS Code extension. No account needed; goes straight to the maintainers.

## What's inside

- **Android app (APK)** — install it, then pair with your desktop controller by scanning the QR code on the dashboard. Pairing needs the same Wi-Fi once; after that the app works from anywhere via the encrypted relay.
- End-to-end encrypted channel between phone and laptop — the relay only ever forwards ciphertext.
- Agent chat, session control, scoped terminals, git status, push notifications, offline outbox.
- One device row per physical phone: re-pairing updates your existing device (keys and token rotate, old credential dies instantly).
- **Self-announcing updates**: from this version on, the app checks the public releases feed (at most every 6 hours) and shows a banner when a newer build is available. No account, no tracking — just this repo's releases API.

## Desktop controller (required)

```bash
git clone https://github.com/piyushptiwari1/bytical-relay.git
cd bytical-relay && pnpm install
pnpm --filter @rdc/desktop-controller dev
```

Open the dashboard link it prints, then scan the pairing QR from the app.

## Notes

- Alpha quality — expect rough edges, and please file issues.
- Privacy: no third-party trackers. See https://relay.bytical.ai/privacy
- Live transparency stats: https://relay.bytical.ai/stats
