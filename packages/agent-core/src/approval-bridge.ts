import type { ApprovalRequest } from "@rdc/protocol";
import { newEventId, nowIso } from "@rdc/shared";
import type { PermissionAnswer, PermissionAsk } from "./types.ts";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (answer: PermissionAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The one approval funnel every adapter shares (IMPLEMENTATION-PLAN S4.2):
 * adapter asks → a wire-visible ApprovalRequest is created → phone (or
 * dashboard) responds → the adapter's promise resolves. Unanswered requests
 * time out as cancelled so agents never hang forever.
 */
export class ApprovalBridge {
  readonly #pending = new Map<string, PendingApproval>();

  constructor(private readonly timeoutMs = 10 * 60 * 1000) {}

  create(
    sessionId: string,
    ask: PermissionAsk,
  ): { request: ApprovalRequest; answer: Promise<PermissionAnswer> } {
    const request: ApprovalRequest = {
      approval_id: newEventId(),
      session_id: sessionId,
      title: ask.title,
      tool_kind: ask.tool_kind,
      options: ask.options,
      requested_at: nowIso(),
    };
    const answer = new Promise<PermissionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.approval_id);
        resolve({ cancelled: true });
      }, this.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.#pending.set(request.approval_id, { request, resolve, timer });
    });
    return { request, answer };
  }

  respond(approvalId: string, optionId: string): ApprovalRequest | null {
    const pending = this.#pending.get(approvalId);
    if (!pending) return null;
    this.#pending.delete(approvalId);
    clearTimeout(pending.timer);
    pending.resolve({ option_id: optionId });
    return pending.request;
  }

  cancelForSession(sessionId: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.request.session_id === sessionId) {
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve({ cancelled: true });
      }
    }
  }

  pendingFor(sessionId: string): ApprovalRequest[] {
    return [...this.#pending.values()]
      .filter((p) => p.request.session_id === sessionId)
      .map((p) => p.request);
  }
}
