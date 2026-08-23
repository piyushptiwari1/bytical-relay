import type { EditorState } from "@rdc/protocol";
import { TypedEmitter } from "@rdc/shared";
import type { ClientContext } from "./dispatcher.ts";

interface EditorConnection {
  state: EditorState | null;
  send: (json: string) => void;
}

/**
 * Live registry of connected editor windows (S6). Keyed by connection context —
 * one VS Code window = one WS connection = one entry. Emits "changed" with the
 * full snapshot so the server can push editor.state_changed to phones.
 */
export class EditorRegistry {
  readonly emitter = new TypedEmitter<{ changed: EditorState[] }>();
  readonly #connections = new Map<ClientContext, EditorConnection>();

  attach(ctx: ClientContext, send: (json: string) => void): void {
    this.#connections.set(ctx, { state: null, send });
  }

  detach(ctx: ClientContext): void {
    const existing = this.#connections.get(ctx);
    this.#connections.delete(ctx);
    if (existing?.state) this.emitter.emit("changed", this.list());
  }

  publish(ctx: ClientContext, state: EditorState): boolean {
    const connection = this.#connections.get(ctx);
    if (!connection) return false;
    connection.state = state;
    this.emitter.emit("changed", this.list());
    return true;
  }

  list(): EditorState[] {
    return [...this.#connections.values()]
      .map((c) => c.state)
      .filter((s): s is EditorState => s !== null);
  }

  /** Send a wire envelope to every editor window that has the project open. */
  deliver(projectId: string, json: string): number {
    let delivered = 0;
    for (const connection of this.#connections.values()) {
      if (connection.state?.project_ids.includes(projectId)) {
        connection.send(json);
        delivered += 1;
      }
    }
    return delivered;
  }
}
