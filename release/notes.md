**Relay by Bytical 0.3.2** — pair from any network.

## New in this release

- **Same Wi-Fi no longer required** — pairing now falls back through the encrypted relay automatically when the local network isolates devices (office and guest Wi-Fi, VPNs). Scan the QR; it just works. The ceremony is unchanged and end-to-end: one-time code, emoji fingerprint, sealed grant — the relay only forwards ciphertext.
- **Pairing that explains itself** — if a connection path fails, the app lists every address it tried and why it failed, with a checklist and a one-tap retry.
- **Check for updates, everywhere** — a button on the phone's home screen and in the VS Code extension (0.2.6) reports "up to date" or offers the download.
- **VS Code-style machine screen** — Work and Projects sections as clean list rows, plus a live status strip (connection · CPU · memory · latency · battery · keep-awake) like VS Code's status bar. Terminals and Git aligned to the same language, with one-tap Stage all / Unstage all.

## Also inside (0.3.x line)

- VS Code-style chat rows with provider identity, markdown + tap-to-copy code, quick replies, Allow/Skip from the notification shade, instant optimistic sends, day-grouped searchable history, human error messages everywhere.

## Get it

- **Android app (APK)** — `relay-by-bytical.apk` below, or [relay.bytical.ai/download](https://relay.bytical.ai/download). Install over the old version; pairings are kept.
- **VS Code extension** — [marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical](https://marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical). Accept the controller update nudge (or run *Set up / update*) so your computer gains the pairing bridge.
- **Standalone controller** (`relay-controller-standalone.tgz`) — extract, `node controller.mjs start`.
