# Relay by Bytical Product Direction

**Brand architecture:** Bytical is the company. Relay is the product. Use the marketing lockup
**Relay by Bytical**, refer to the mobile app as **Relay**, and keep `RDC` as the internal protocol
and controller namespace. Relay remains a working product name until a formal trademark clearance
is complete.

## Product promise

Relay is a secure mobile control plane for developer work that continues on the user's own
computer. It is not a mobile code editor and it is not another cloud coding agent. VS Code remains
the desktop workspace; the phone is the place to start, supervise, approve, review, and recover
work.

## Product decisions

### Connection and identity

- A phone connects through cryptographic device pairing, not a GitHub, Copilot, Claude, or other
  model-provider login. It must work when no provider is installed.
- GitHub, Copilot, and Claude authentication remain local to the laptop and are used only by their
  respective agent adapters. Relay never stores or proxies their credentials.
- A future Bytical account is optional. It may provide Relay discovery, device recovery, and
  subscription management, but it must never grant terminal or project access by itself.
- Connection order is LAN direct, then secure relay. Private alpha users should be able to choose
  Tailscale/WireGuard while the hosted relay is hardened.
- The hosted relay must use `wss`, separate controller credentials from device credentials, and
  issue short-lived, device-bound connection tickets. A shared relay secret must not be sent to a
  phone.

### Agent experience

- The phone presents stable developer jobs: **Build**, **Debug**, **Test**, **Review**,
  **Research**, and **Release**. These are task profiles with clear permissions and context; they
  are not separate model brands.
- Copilot is the first provider because the controller already supports it through ACP. Claude Code
  is the second provider through the same session, event, permission, and resume contract.
- Other providers are added only after they pass the same provider conformance suite. Raw model
  names live in a provider picker under an advanced control, not in primary navigation.
- An agent owns no source of truth. The controller journals events, VS Code owns editor state, and
  the phone renders replayable projections.

### VS Code experience

- Bytical follows VS Code interaction patterns without visually cloning the entire editor: compact
  status, command palette actions, familiar source-control and activity vocabulary, dense
  information hierarchy, and Codicons where the extension supports them.
- The extension is an integration layer, not a second IDE. Its first primary command is
  **RDC: Open in Agents**, which starts a controller-owned session for the active indexed workspace
  and hands it to the phone.
- We do not depend on undocumented Copilot Chat-panel internals. The extension may open the native
  chat UI, but session control flows through the supported controller and ACP path.

### Mobile experience

- The first screen is an operational inbox: approvals, running work, failed work, machine health,
  and "while you were away" changes. It is not a dashboard of decorative cards.
- A workspace screen groups agent sessions, Git changes, files, terminals, and editor presence.
  Every screen has loading, empty, disconnected, permission-denied, and retry states.
- The terminal is a deliberate expert escape hatch. Start, write, kill, Git mutation, and external
  service exposure require controller-side policy decisions and auditable user intent.
- The app must clearly show whether it is on LAN or relay, when its displayed state was last
  refreshed, and whether the paired phone is presently reachable.

## Delivery sequence

### P0: Trust before reachability

1. Bind a socket identity to the authenticated `DeviceRecord`; reject a mismatched `hello` identity.
2. Persist token expiration, enforce it, support rotation and per-device/all-device revocation.
3. Enforce server-side capabilities for every command and add project-level grants before any
   terminal, Git mutation, or agent-control operation is exposed remotely.
4. Add a redacted, append-only audit trail for all privileged commands and approval decisions.

### P1: Smooth connection

1. Track authenticated device presence, `last_seen`, transport, and relay health.
2. Make the mobile client migrate from failed LAN reconnects to relay without requiring an app
   restart, then retry LAN when it returns.
3. Complete release-build FCM delivery and actionable approval notifications. A suspended phone
   cannot depend on a WebSocket.
4. Use device-bound tickets and `wss`; add relay rate limits, monitoring, and failure-mode tests.

### P2: VS Code-native handoff

1. Ship and manually validate `RDC: Open in Agents` from the command palette and status bar.
2. Add a compact workspace activity/status view with controller availability, active agent count,
   and an explicit "Continue on phone" state.
3. Add an "Open in VS Code" round trip from phone file and diff views, preserving project and line.

### P3: Mature mobile control plane

1. Build the activity/inbox-first information architecture and robust approval retry behavior.
2. Add connection freshness, offline recovery, accessible controls, and mobile automated tests.
3. Add review-first Git and file-change surfaces before expanding terminal control.

### P4: Provider and role expansion

1. Add the Claude Code adapter using its supported SDK permission callback and session recovery.
2. Implement the six task profiles as policy and context presets shared across providers.
3. Add OpenCode, Codex, and Gemini only behind the adapter conformance suite.

### P5: Play Store release

1. Use EAS `production` to create an Android App Bundle, not an internal APK.
2. Create final adaptive icon, splash artwork, screenshots, feature graphic, privacy policy, data
   safety declaration, support URL, and account-deletion flow if an optional cloud account exists.
3. Keep only justified permissions. Camera is used for pairing QR codes; microphone stays absent
   until a shipped voice feature requires it.
4. Add release crash reporting with redaction, accessibility testing, physical-device E2E tests,
   and an uninstall/lost-phone recovery flow.

## Implementation Status (2026-08-30)

The following foundations are implemented in the current workspace and covered by controller,
protocol, mobile type, bundle, and live-controller checks:

- Paired connections bind the authenticated device record to `hello` identity. Every controller
  command now checks the paired device's explicit capability scope; local-owner dashboard and VS
  Code connections retain their local authority. New and legacy default pairings grant supervised
  agent work and read-only Git/terminal visibility, while Git mutation and raw terminal control
  remain unavailable by default.
- Device records have token expiry, encrypted self-token rotation, per-device and all-device
  revocation, direct/relay last-seen state, and a local-owner-only dashboard device panel. The
  panel redacts token hashes and device keys. Privileged requests and revocations enter a
  persistent, hash-chained audit log without prompts, shell input, tokens, or source contents.
- Agent instructions can be accepted while a turn is active and drain through the controller in
  FIFO order. Relay also saves an instruction in encrypted phone storage while disconnected,
  retries it through a stable idempotency key after reconnecting, and visibly distinguishes
  controller-queued work from phone-saved work waiting to send.
- The mobile home is an operational Relay inbox: decisions and failures appear first, followed by
  running and resumable work, then concise computer connection/freshness state. Live direct-LAN
  sessions can move to the encrypted relay after a failure and later return to LAN.
- Phone relay access uses a 14-day rolling bundle of daily, short-lived, HMAC-signed tickets bound
  to the paired device and machine. The controller credential and the paired-device controller
  token never enter a phone relay URL. Both relay and controller verify tickets before an E2EE
  channel can begin.
- The controller push payload is privacy-safe and category-aware. Mobile review/skip actions are
  registered; a skip is persisted until Relay can deliver it through the encrypted approval route.
  Release-build FCM/APNs credentials and physical-device push validation remain external setup.
- `RDC: Open in Agents` is available from the VS Code status bar and Command Palette, starts a
  controller-owned session for the active indexed workspace, and its extension bundle is built.

Remaining delivery dependencies are intentionally not simulated: project-level grants and
controller policy profiles, deployment of the ticket-aware relay behind TLS with rate limits and
monitoring, Firebase/APNs release credentials, physical-device notification testing, the Claude
Code adapter, and localhost service viewing.

## Working roles for development

Use seven active ownership roles, not a large swarm of agents modifying overlapping files:

| Role | Owns |
| --- | --- |
| Product architect | scope, ADRs, non-goals, sequencing |
| Security and gateway | pairing, capability enforcement, relay, audit |
| State and recovery | journal, idempotency, replay, reconnect, migrations |
| Controller builder | Windows lifecycle, filesystem, terminal, Git, process ownership |
| Agent integration | ACP and provider adapters, normalized sessions and permissions |
| VS Code and mobile UX | extension workflows, mobile information architecture, design system |
| Quality and release | conformance, physical-device E2E, packaging, store compliance |

Each role owns a bounded surface. Independent security review follows every privileged transport or
controller change; provider adapters do not grade their own behavior.

## Explicit non-goals for the first public release

- No full mobile clone of VS Code.
- No cloud-hosted source-code mirror or proxying model-provider credentials.
- No arbitrary unaudited terminal access from an unscoped paired device.
- No promise that a sleeping laptop can be remotely woken without separately configured hardware
  and network support.
- No model-provider login as a prerequisite for pairing a phone to its owner-controlled computer.