import type { AgentUpdate } from "@rdc/protocol";

/** What an adapter asks the user when the agent wants to run a tool. */
export interface PermissionAsk {
  title: string;
  tool_kind: string;
  options: Array<{ option_id: string; name: string; option_kind: string }>;
}

export type PermissionAnswer = { option_id: string } | { cancelled: true };

export interface AdapterCallbacks {
  onUpdate(update: AgentUpdate): void;
  onPermission(ask: PermissionAsk): Promise<PermissionAnswer>;
  /** Fired once when the underlying agent process dies (error = abnormal). */
  onExit(error: string | null): void;
}

export interface AgentSessionHandle {
  readonly providerSessionId: string;
  prompt(text: string): Promise<{ stop_reason: string }>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

/** A conversation that lives in the provider's own store (laptop CLI history). */
export interface NativeSession {
  native_id: string;
  title: string;
  cwd: string;
  updated_at: string;
}

/** One per agent product (PLAN §8) — copilot, opencode, claude… */
export interface AgentAdapter {
  readonly id: string;
  detect(): Promise<{ available: boolean; detail: string }>;
  createSession(opts: { cwd: string; callbacks: AdapterCallbacks }): Promise<AgentSessionHandle>;
  /** Resume a provider-native session with full context (ACP session/load). */
  resumeSession?(opts: {
    nativeId: string;
    cwd: string;
    callbacks: AdapterCallbacks;
  }): Promise<AgentSessionHandle>;
  /** Conversations from the provider's own history (both laptop- and phone-started). */
  listNativeSessions?(): Promise<NativeSession[]>;
}
