import {
  ArrowDown,
  ArrowUpRight,
  BellRing,
  Check,
  ChevronRight,
  Command,
  Github,
  Laptop,
  LockKeyhole,
  Radio,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./relay.css";

const GITHUB_URL = "https://github.com/piyushptiwari1/bytical-relay";
// evergreen: always redirects to the newest APK asset (vercel.json)
const DOWNLOAD_URL = "/download";
const FEEDBACK_URL = "https://ws.relay.bytical.ai/a/feedback";

type FeedbackKind = "review" | "feature" | "update_request" | "bug";
const FEEDBACK_LABELS: Record<FeedbackKind, string> = {
  review: "Review",
  feature: "Feature idea",
  update_request: "Update request",
  bug: "Bug",
};

function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>("review");
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  const submit = async () => {
    if (!message.trim() || (kind === "review" && rating === 0)) return;
    setState("sending");
    try {
      const response = await fetch(FEEDBACK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          rating: kind === "review" ? rating : undefined,
          message: message.trim(),
          contact: contact.trim() || undefined,
          surface: "website",
        }),
      });
      setState(response.ok ? "done" : "error");
      if (response.ok) {
        setMessage("");
        setContact("");
        setRating(0);
        setTimeout(() => {
          setOpen(false);
          setState("idle");
        }, 2200);
      }
    } catch {
      setState("error");
    }
  };

  return (
    <div className="feedback-root">
      {open ? (
        <div className="feedback-panel" role="dialog" aria-label="Send feedback">
          <div className="feedback-head">
            <strong>Tell us anything</strong>
            <button type="button" aria-label="Close" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <div className="feedback-kinds">
            {(Object.keys(FEEDBACK_LABELS) as FeedbackKind[]).map((k) => (
              <button
                key={k}
                type="button"
                className={k === kind ? "on" : ""}
                onClick={() => setKind(k)}
              >
                {FEEDBACK_LABELS[k]}
              </button>
            ))}
          </div>
          {kind === "review" ? (
            <div className="feedback-stars" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={n <= rating ? "on" : ""}
                  aria-label={`${n} star${n > 1 ? "s" : ""}`}
                  onClick={() => setRating(n)}
                >
                  ★
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder={
              kind === "bug"
                ? "What broke? What did you expect?"
                : kind === "review"
                  ? "How is Relay working for you?"
                  : "What should Relay do?"
            }
          />
          <input
            type="text"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={200}
            placeholder="Email or GitHub (optional — only if you want a reply)"
          />
          <button
            type="button"
            className="feedback-send"
            disabled={state === "sending" || !message.trim() || (kind === "review" && rating === 0)}
            onClick={() => void submit()}
          >
            {state === "sending" ? "Sending…" : state === "done" ? "Thank you!" : "Send"}
          </button>
          {state === "error" ? <p className="feedback-error">Could not send — try again.</p> : null}
          <p className="feedback-note">Goes straight to the maintainers. No account needed.</p>
        </div>
      ) : (
        <button type="button" className="feedback-fab" onClick={() => setOpen(true)}>
          Feedback
        </button>
      )}
    </div>
  );
}

/** Crisp, legible product mock — real text, no WebGL, sharp on every screen. */
function HeroVisual() {
  return (
    <div className="hero-visual" aria-hidden="true">
      <div className="mock mock-laptop float-a">
        <div className="mock-chrome">
          <span />
          <span />
          <span />
          <em>VS Code — Relay session</em>
        </div>
        <div className="mock-body">
          <div className="mock-line dim">payments/retry-queue.ts · agent editing</div>
          <div className="mock-line">
            <b>relay ›</b> refactor the retry queue, add tests
          </div>
          <div className="mock-line stream">
            rewriting enqueue() with backoff
            <span className="caret" />
          </div>
          <div className="mock-line ok reveal r4">✓ 12 files changed · tests passing</div>
          <div className="mock-line dim">Build mode · continues while you're away</div>
        </div>
      </div>
      <div className="mock mock-phone float-b">
        <div className="phone-head">
          <span className="pulse-dot" /> laptop connected
        </div>
        <div className="bubble agent reveal r1">
          Migration plan is ready — 3 steps, no data loss. Want me to start?
        </div>
        <div className="approval-card reveal r2">
          <div className="approval-kicker">Approval requested</div>
          <div className="approval-cmd">pnpm test · workspace</div>
          <div className="approval-actions">
            <b className="tap">Allow once</b>
            <span>Deny</span>
          </div>
        </div>
        <div className="bubble user reveal r3">Approved — continue with step 2</div>
      </div>
    </div>
  );
}

function App() {
  return (
    <main>
      <section className="hero" id="top">
        <HeroVisual />
        <header className="site-header">
          <a className="brand" href="#top" aria-label="Relay by Bytical home">
            <span className="company-name">Bytical</span>
            <span className="brand-divider" aria-hidden="true" />
            <span className="product-name">Relay</span>
          </a>
          <nav aria-label="Primary navigation">
            <a href="#workflow">Experience</a>
            <a href="#security">Trust</a>
            <a href="#faq">FAQ</a>
            <a href="#download">Download</a>
          </nav>
          <a className="nav-action" href={GITHUB_URL} target="_blank" rel="noreferrer">
            <Github size={16} strokeWidth={2.2} />
            <span>View project</span>
          </a>
        </header>

        <div className="hero-copy">
          <p className="eyebrow">
            <Radio size={14} /> Works with GitHub Copilot · Claude Code
          </p>
          <h1>Your coding agent, in your pocket.</h1>
          <p className="hero-statement">
            The agent keeps working on your laptop. You watch, approve, and steer it from your phone
            — from anywhere.
          </p>
          <p className="hero-description">
            Pair once with a QR code. Then start new sessions, continue VS Code chats, approve
            commands, and get notified when work finishes — over an encrypted connection. No cloud
            IDE, no code upload: your laptop stays the workstation.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href={DOWNLOAD_URL} data-track="hero-download">
              Get Relay for Android <ArrowDown size={17} />
            </a>
            <a className="button button-secondary" href="#download">
              How it works <ChevronRight size={17} />
            </a>
          </div>
          <ol className="hero-steps" aria-label="Three steps to start">
            <li>
              <b>1</b> Install the app
            </li>
            <li>
              <b>2</b> Add the VS Code extension
            </li>
            <li>
              <b>3</b> Scan once — chat anywhere
            </li>
          </ol>
        </div>

        <div className="hero-caption">
          <span>
            <Laptop size={15} /> Your machine. Your context. Your call.
          </span>
        </div>
      </section>

      <section className="signal-strip" aria-label="Relay principles">
        <p>Built for the work that continues after you leave the desk.</p>
        <p>Relay is a product of Bytical.</p>
      </section>

      <section className="workflow section" id="workflow">
        <div className="section-heading">
          <p className="eyebrow eyebrow-ink">
            <Command size={15} /> An extension of your existing workspace
          </p>
          <h2>
            Move away from the desk.
            <br />
            Not away from the work.
          </h2>
        </div>
        <ol className="workflow-list" id="start">
          <li>
            <span className="step-number">01</span>
            <Command size={28} />
            <h3>Begin where you work</h3>
            <p>
              Open Relay from VS Code with the relevant workspace already selected. The session
              belongs to your controller, not a browser tab.
            </p>
          </li>
          <li>
            <span className="step-number">02</span>
            <Smartphone size={28} />
            <h3>Stay in the loop</h3>
            <p>
              Follow activity, review a request, approve a guarded step, or make a focused course
              correction from the phone.
            </p>
          </li>
          <li>
            <span className="step-number">03</span>
            <TerminalSquare size={28} />
            <h3>Return with clarity</h3>
            <p>
              Back at the laptop, the session, Git changes, terminal output, and activity trail are
              exactly where you left them.
            </p>
          </li>
        </ol>
      </section>

      <section className="control-band">
        <div className="control-copy">
          <p className="eyebrow">
            <Sparkles size={15} /> Purpose-built for the phone
          </p>
          <h2>
            Control the moment.
            <br />
            Keep the craft on desktop.
          </h2>
          <p>
            Relay is deliberately focused. It gives you the awareness, decisions, review, and
            recovery that matter while you are away, without pretending a phone is a workstation.
          </p>
          <a className="text-link" href="#security">
            How the trust model works <ArrowUpRight size={17} />
          </a>
        </div>
        <div
          className="control-shot"
          role="img"
          aria-label="Illustration of the Relay mobile control surface"
        >
          <div className="phone-shell">
            <div className="phone-notch" />
            <div className="phone-ui">
              <div className="phone-topline">
                <span>RELAY</span>
                <span className="live-dot">LIVE</span>
              </div>
              <div className="machine-card">
                <span>CONNECTED MACHINE</span>
                <strong>workstation-01</strong>
                <small>LAN direct / 24ms</small>
              </div>
              <div className="activity-row">
                <BellRing size={18} />
                <div>
                  <strong>Review login failures</strong>
                  <span>Copilot is waiting for approval</span>
                </div>
                <ChevronRight size={18} />
              </div>
              <div className="approve-card">
                <span>PERMISSION REQUEST</span>
                <strong>Run test migration</strong>
                <span className="approval-button">
                  Allow once <Check size={15} />
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="field-report section">
        <div className="photo-block">
          <img
            src="https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=1600&q=85"
            alt="Developer working at a laptop"
          />
          <span>Built for the moment work needs your attention.</span>
        </div>
        <div className="field-copy">
          <p className="eyebrow eyebrow-ink">
            <Laptop size={15} /> Your machine stays in charge
          </p>
          <h2>Built around what you already trust.</h2>
          <p>
            Copilot is available through a durable session model today. Claude Code, Codex, and
            future providers will follow the same adapter contract. Relay does not mirror your
            source code into a vendor cloud or collect the credentials that make your tools work.
          </p>
          <ul className="check-list">
            <li>
              <Check size={18} /> Local filesystem and terminal remain local
            </li>
            <li>
              <Check size={18} /> Provider sessions are normalized, not scraped
            </li>
            <li>
              <Check size={18} /> Reconnect through replayable event streams
            </li>
          </ul>
        </div>
      </section>

      <section className="security section" id="security">
        <div className="section-heading">
          <p className="eyebrow eyebrow-ink">
            <ShieldCheck size={15} /> Designed for real development machines
          </p>
          <h2>
            Convenience begins
            <br />
            with clear boundaries.
          </h2>
        </div>
        <div className="security-grid">
          <article>
            <span className="security-icon">
              <LockKeyhole size={24} />
            </span>
            <h3>Pairing, not provider logins</h3>
            <p>
              A phone establishes a device relationship with the controller. Model-provider accounts
              remain local to the laptop.
            </p>
          </article>
          <article>
            <span className="security-icon">
              <ShieldCheck size={24} />
            </span>
            <h3>Deliberate permission</h3>
            <p>
              Device capabilities are enforced by the local controller. Elevated terminal and Git
              actions remain unavailable until explicit access and policy controls are in place.
            </p>
          </article>
          <article>
            <span className="security-icon">
              <Radio size={24} />
            </span>
            <h3>Close when possible</h3>
            <p>
              Relay prefers your local network and uses a secure remote path only when you leave it.
              Connection state stays visible.
            </p>
          </article>
        </div>
      </section>

      <section className="download section" id="download">
        <div className="section-heading">
          <p className="eyebrow eyebrow-ink">
            <Smartphone size={15} /> Android alpha
          </p>
          <h2>Take Relay with you.</h2>
          <p>
            Relay is in open alpha. The app is free, open source, and works with the machines you
            pair — nothing else.
          </p>
        </div>
        <div className="download-grid">
          <div className="download-card">
            <h3>1 · Get the app</h3>
            <p>One tap — the newest version, straight from our releases. Android 10+.</p>
            <a className="button button-primary" href={DOWNLOAD_URL} data-track="android-apk">
              Download for Android <ArrowUpRight size={17} />
            </a>
            <div className="download-qr">
              <img
                src="/qr-download.svg"
                alt="QR code — scan with your phone to install Relay"
                width={96}
                height={96}
              />
              <span>On your laptop? Scan with your phone — it downloads straight away.</span>
            </div>
          </div>
          <div className="download-card">
            <h3>2 · Set up your computer</h3>
            <p>
              Install the <strong>Relay by Bytical</strong> VS Code extension and run{" "}
              <em>“Relay: Set up this computer”</em> — it installs, starts, and opens pairing for
              you.
            </p>
            <a
              className="button"
              href="https://marketplace.visualstudio.com/items?itemName=bytical.relay-by-bytical"
              target="_blank"
              rel="noreferrer"
              data-track="vscode-marketplace"
            >
              Get it on the VS Code Marketplace <ArrowUpRight size={17} />
            </a>
            <details>
              <summary>Prefer the terminal?</summary>
              <code>git clone {GITHUB_URL.replace("https://", "")}</code>
              <code>pnpm install && pnpm --filter @rdc/desktop-controller dev</code>
            </details>
          </div>
          <div className="download-card">
            <h3>3 · Pair once</h3>
            <p>
              The pairing panel shows a QR — scan it with Relay on the same Wi-Fi, check the emoji
              match, confirm. After that, Relay works from anywhere.
            </p>
          </div>
        </div>
      </section>

      <section className="faq section" id="faq">
        <div className="section-heading">
          <p className="eyebrow eyebrow-ink">
            <Sparkles size={15} /> Common questions
          </p>
          <h2>Direct answers.</h2>
        </div>
        <div className="faq-grid">
          <details>
            <summary>Can I control VS Code and my coding agent from my phone?</summary>
            <p>
              Yes. Relay pairs your phone with the VS Code extension on your computer. You can
              continue Copilot chats, start new agent sessions, approve commands, and watch progress
              from anywhere — the agent keeps running on your machine.
            </p>
          </details>
          <details>
            <summary>
              Which AI coding agents does Relay work with — GitHub Copilot, Claude Code?
            </summary>
            <p>
              GitHub Copilot and Claude Code are supported today. When both are installed, you pick
              a provider per session. Codex and other providers follow the same adapter contract
              next.
            </p>
          </details>
          <details>
            <summary>Does it work on Windows, macOS, and Linux?</summary>
            <p>
              Yes — the desktop side runs on Windows, macOS, and Linux, installed in two clicks from
              the VS Code extension with zero system dependencies. The phone app is on Android
              today; iOS is on the roadmap.
            </p>
          </details>
          <details>
            <summary>Is my source code uploaded anywhere?</summary>
            <p>
              No. Code, files, Git data, terminal output, and agent conversations stay on your
              machine and your paired phone, end-to-end encrypted in transit. The optional relay
              server forwards ciphertext it cannot read.
            </p>
          </details>
          <details>
            <summary>Does it work when I leave home or the office?</summary>
            <p>
              Yes. On the same Wi-Fi, your phone connects directly. Anywhere else it falls back to
              an encrypted relay automatically — as long as your computer is on and online.
            </p>
          </details>
          <details>
            <summary>Can my phone run destructive commands?</summary>
            <p>
              Not by default. A paired phone can supervise agents and review Git and terminal
              output, but Git mutations and raw terminal control require explicit elevated access.
              Every privileged action lands in a tamper-evident audit log.
            </p>
          </details>
          <details>
            <summary>Do I need an account?</summary>
            <p>
              No accounts. Pairing is a QR handshake between your phone and your machine. Your
              model-provider accounts (like Copilot) stay configured on the machine itself.
            </p>
          </details>
          <details>
            <summary>Is Relay free?</summary>
            <p>
              Relay is open source under Apache-2.0 and free during alpha. Live, transparent usage
              numbers are published on our <a href="/stats">stats page</a>.
            </p>
          </details>
        </div>
      </section>

      <section className="open-source" id="contribute">
        <div className="open-source-art" aria-hidden="true">
          <span>git status</span>
          <span>main</span>
          <span>open source</span>
        </div>
        <div>
          <p className="eyebrow">
            <Github size={15} /> Building Relay in the open
          </p>
          <h2>Help make remote developer work feel considered.</h2>
          <p>
            Relay is an alpha product from Bytical for people who care about reliable local agents,
            intentional mobile control, and open technical design.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href={GITHUB_URL} target="_blank" rel="noreferrer">
              Explore the project <ArrowUpRight size={17} />
            </a>
            <a className="button button-secondary" href="#security">
              Read the approach <ChevronRight size={17} />
            </a>
          </div>
        </div>
      </section>

      <footer>
        <a className="brand" href="#top">
          <span className="company-name">Bytical</span>
          <span className="brand-divider" aria-hidden="true" />
          <span className="product-name">Relay</span>
        </a>
        <p>Relay is a product of Bytical.</p>
        <nav className="footer-links" aria-label="Footer">
          <a href="#download">Download</a>
          <a href="/stats">Live stats</a>
          <a href="/privacy">Privacy</a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub <ArrowUpRight size={15} />
          </a>
        </nav>
      </footer>
      <FeedbackWidget />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
