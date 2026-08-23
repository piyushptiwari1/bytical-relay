import type { ChildProcess } from "node:child_process";

type Handler = (params: unknown) => Promise<unknown> | unknown;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (cause: Error) => void;
}

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio — the ACP
 * transport (agentclientprotocol.com). Both directions support requests and
 * notifications; agent→client requests (e.g. session/request_permission) are
 * served by registered handlers.
 */
export class NdjsonRpc {
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #requestHandlers = new Map<string, Handler>();
  readonly #notificationHandlers = new Map<string, (params: unknown) => void>();
  #buffer = "";
  #closed = false;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onData(chunk));
    child.on("exit", () => this.#failAll(new Error("agent process exited")));
  }

  onRequest(method: string, handler: Handler): void {
    this.#requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.#notificationHandlers.set(method, handler);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.#nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.#write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.#closed = true;
    this.#failAll(new Error("rpc closed"));
  }

  #write(message: unknown): void {
    if (this.#closed) return;
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) this.#onMessage(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #onMessage(line: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // agents may log non-JSON to stdout — ignore
    }
    if (message.method !== undefined && message.id !== undefined) {
      const handler = this.#requestHandlers.get(message.method);
      const id = message.id;
      if (!handler) {
        this.#write({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `method not found: ${message.method}` },
        });
        return;
      }
      void Promise.resolve(handler(message.params))
        .then((result) => this.#write({ jsonrpc: "2.0", id, result }))
        .catch((cause: unknown) =>
          this.#write({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: String(cause) },
          }),
        );
      return;
    }
    if (message.method !== undefined) {
      this.#notificationHandlers.get(message.method)?.(message.params);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  }

  #failAll(cause: Error): void {
    for (const [, pending] of this.#pending) pending.reject(cause);
    this.#pending.clear();
  }
}
