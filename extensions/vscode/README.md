# Relay by Bytical

Control your dev machine and AI coding agents **from your phone** — end-to-end encrypted, open source.

## Two clicks to set up

1. Install this extension.
2. Run **“Relay: Set up this computer”** (Command Palette or the Relay status-bar item).

The extension downloads and runs the Relay controller for you, then opens the pairing panel: scan the QR with the [Relay Android app](https://github.com/piyushptiwari1/bytical-relay/releases/latest), check the emoji fingerprints match, confirm — done. Pairing needs the same Wi-Fi once; after that your phone works from anywhere via the encrypted relay.

## What you get

- **Agent chat on the go** — answer questions, approve plans, and steer Copilot CLI sessions from your phone; sessions started in VS Code can be continued remotely (“Relay: Open in Agents”).
- **Presence** — your phone sees the active file, diagnostics, tasks, and last terminal command.
- **Safety rails** — phones get supervised-work scopes by default (no raw terminals, no git mutations), every sensitive action is audit-logged, devices are revocable instantly.
- **Privacy** — no third-party trackers, the relay only forwards ciphertext. [Privacy policy](https://relay.bytical.ai/privacy) · [Live stats](https://relay.bytical.ai/stats)

## Commands

| Command | What it does |
| --- | --- |
| Relay: Set up this computer | One-click install + start + pair |
| Relay: Pair phone | Show the pairing QR in an editor panel |
| Relay: Menu | All actions (also on the status-bar item) |
| Relay: Open in Agents | Start an agent for this workspace, follow it on your phone |
| Relay: Stop controller / Show logs | Housekeeping |

Requires Git and Node.js 22.5+ on this machine. Contributors can point `relay.appPath` at an existing checkout.

Apache-2.0 · [Source](https://github.com/piyushptiwari1/bytical-relay) · [Website](https://relay.bytical.ai)
