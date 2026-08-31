# Relay by Bytical — Platform Matrix

One sheet for every surface: what exists, where it ships from, how it updates, and what keeps
versions in sync. Update this file in the same commit as any change to a surface's distribution,
version, or credentials. Strategy lives in [PRODUCT-DIRECTION.md](PRODUCT-DIRECTION.md).

## 1 · Surfaces

| Surface | Status | Version | Code | Distribution | Update path | Analytics |
| --- | --- | --- | --- | --- | --- | --- |
| **Website** relay.bytical.ai | 🟢 Live | rolling | `apps/site` | Vercel (`relay-bytical`), auto-deploy on public push | git push → Vercel | first-party beacon → `/a/collect` |
| **Android app** | 🟢 Alpha | 0.1.1 | `apps/mobile` | GitHub Releases APK (`releases/latest`) | in-app banner (checks releases API ≤ 6 h) | `app_launch` ping |
| **iOS app** | ⚪ Not started | — | same `apps/mobile` codebase | TestFlight → App Store (needs Apple Dev account) | TestFlight / App Store | same ping |
| **Desktop controller** (Win) | 🟢 Alpha | rolling | `apps/desktop-controller` | via VS Code extension setup, or git clone | `git pull` (extension "Set up / update") | `platform_up` ping |
| **Desktop controller** (macOS/Linux) | 🟡 Untested | rolling | same | same (config paths already per-OS) | same | same |
| **VS Code extension** | 🟢 Live | 0.1.2 | `extensions/vscode` | [Marketplace `bytical.relay-by-bytical`](https://marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical) + VSIX on releases | Marketplace auto-update | — |
| **Open VSX** (Cursor/VSCodium) | ⚪ Not started | — | same VSIX | open-vsx.org (needs namespace `bytical`) | Open VSX auto-update | — |
| **Relay server** | 🟢 Live | rolling | `apps/relay` | EC2 `rdc-relay` (ap-south-1), `wss://ws.relay.bytical.ai` | GH workflow "Relay deploy" (private repo) | `/healthz`, relay_online on `/stats` |
| **Analytics service** | 🟢 Live | rolling | `apps/relay` (analytics.mjs :8444) | same EC2, Caddy `/a/*` | `tooling/deploy-analytics.py` | is the analytics |
| **Owner console** `/data` | 🟢 Live | rolling | `apps/desktop-controller` | local only, password-gated | with controller | reads everything |
| **Public stats** `/stats` | 🟢 Live | rolling | `apps/site/public/stats.html` | Vercel | with site | reads `/a/public` |

## 2 · Agent providers

| Provider | Status | Contract |
| --- | --- | --- |
| Copilot CLI | 🟢 Live | ACP adapter — sessions, events, permissions, resume |
| VS Code Copilot Chat (handoff) | 🟢 Live | read `chatSessions` → seed Copilot CLI (`agent.resume`, probe: `pnpm probe resume`) |
| Claude Code | 🔵 Next (P4) | same adapter contract + provider conformance suite |
| Codex / Gemini CLI | ⚪ Later | only after passing the same conformance suite |

## 3 · Version & release train

**Source of truth: git tag `v*` on the public repo.** One tag ships everything releasable:

```
EAS build APK → pin sha256 in release/artifact.json → commit → tag vX.Y.Z-alpha → push tag
  └─ CI (Release workflow): verify APK hash → build VSIX → GitHub Release (APK + VSIX)
                                                → vsce publish to Marketplace (VSCE_PAT)
```

- Extension-only fixes (icon, README): **manual dispatch** of the Release workflow → Marketplace
  publish from `main`, no tag needed.
- Version rule: all surfaces share the **minor** (0.1.x now, 0.2.x next feature wave); patch
  numbers move independently per surface. App version lives in `apps/mobile/app.json`, extension
  version in `extensions/vscode/package.json` — bump both when tagging a minor.
- Relay/analytics/controller are rolling (deployed from main); no user-facing version.

## 4 · Credentials & keys registry (locations only — never commit values)

| Key | Purpose | Where it lives | Rotation |
| --- | --- | --- | --- |
| `VSCE_PAT` | Marketplace publish (CI + manual vsce) | GitHub secret on public repo · created at `dev.azure.com/byticalai/_usersSettings/tokens` (scope: Marketplace Manage, all orgs) | expires 2027-08-30 · **all-orgs PATs die Dec 2026 → re-issue before** |
| Expo account | EAS Android/iOS builds | `piyushptiwari` EAS login on this machine (`~/.expo`) | — |
| AWS profile `rdc-dev` | relay/analytics infra (ap-south-1) | local AWS credentials | — |
| Relay token | controller ↔ relay auth | `%LOCALAPPDATA%/rdc/config.json` (`relay.token`) + EC2 env | rotate via stack redeploy |
| Analytics token | `/ingest` + `/stats` auth | same config (`analytics.token`) + `/etc/rdc-analytics.env` on EC2 | `tooling/deploy-analytics.py <token>` |
| Local owner token | dashboard/API on :8347 | `config.json` (`local_token`) | regenerate in config |
| Data console password | `/data` owner console | `config.json` (`data_password`) | edit config |
| Git identities | private=piyushptiwari, public=piyushptiwari1 | GCM per-repo (`useHttpPath` + per-URL usernames) | `git credential approve` |
| Play Store / FCM | P5 — not created yet | — | — |
| Apple Developer | iOS — not created yet | — | — |

**Direct Marketplace publish from any machine** (no CI):
`npx -y @vscode/vsce publish --no-dependencies --packagePath <vsix> -p <PAT>` — get the PAT value
by regenerating `vsce-relay-publish` at dev.azure.com/byticalai (values are shown only once, to you).

## 5 · Brand & identity sync

| Asset | Current | Where |
| --- | --- | --- |
| Product mark v2 (dark tile + blue gradient broadcast glyph) | 🟢 | extension `icon.png`, site `favicon.svg`, `og.png` |
| Company logo (bytical "b.") | 🟡 staged, needs portal Save | Marketplace publisher profile |
| Publisher domain badge | 🟡 DNS verified, awaiting Microsoft review | Marketplace |
| Links | product `https://relay.bytical.ai` · company `https://bytical.ai` · LinkedIn `https://www.linkedin.com/company/bytical` · repo `github.com/piyushptiwari1/bytical-relay` | site JSON-LD `sameAs`, publisher profile, extension manifest |

## 6 · Gap list (priority order)

1. **Phone E2E on v0.1.1-alpha** — install APK, re-pair (all old pairings revoked), verify relay
   path + notifications + outbox. *(user action — everything else is staged on it)*
2. **P4 Claude Code adapter** — second provider through the existing contract.
3. **P5 Play Store track** — Firebase/FCM, store listing assets, crash reporting, `eas submit`
   closed testing (privacy page ✅ done).
4. **Open VSX publish** — same VSIX, reaches Cursor/VSCodium/Windsurf users.
5. **macOS/Linux controller validation** — paths exist, needs a real run + keep-awake/pty checks.
6. **iOS** — after Play Store: Apple Dev account, EAS iOS build, TestFlight.
7. **Hardening** — close public `ws://:8443` once all phones are on ticket APKs; relay
   monitoring/alerting; MaxMind geo (replace ip-api) before real traffic.
8. **npm CLI** (`@bytical/relay-cli`) — controller without git clone, enables `npx` quick start.
