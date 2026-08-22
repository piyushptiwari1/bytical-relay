import {
  DebugEcho,
  DebugEchoed,
  Hello,
  HelloAck,
  HelloReject,
  type KnownMessage,
  negotiateVersion,
  parseInbound,
  protocolError,
  SUPPORTED_VERSIONS,
  SyncReplay,
} from "@rdc/protocol";
import { newEventId, nowIso } from "@rdc/shared";
import { describe, expect, test } from "vitest";
import { SqliteEventStore } from "../src/index.ts";

/**
 * S0 demo gate (IMPLEMENTATION-PLAN S0): a sample command round-trips
 * controller ⇄ in-memory client with schema validation, sequence assignment,
 * replay, and idempotent retry.
 */
class MiniController {
  readonly store = new SqliteEventStore(":memory:");
  readonly machineId = "machine_test";
  readonly stream = "proj_demo";

  /** Takes raw wire JSON, returns raw wire JSON responses — full schema validation both ways. */
  handle(rawJson: string): string[] {
    const parsed = parseInbound(rawJson);
    if (!parsed.ok) {
      return [
        JSON.stringify(HelloReject.create({ error: parsed.error, supported: SUPPORTED_VERSIONS })),
      ];
    }
    return this.dispatch(parsed.value).map((m) => JSON.stringify(m));
  }

  private dispatch(msg: KnownMessage): unknown[] {
    switch (msg.type) {
      case "hello": {
        const negotiated = negotiateVersion(SUPPORTED_VERSIONS, msg.payload.protocol);
        if (negotiated === null) {
          return [
            HelloReject.create({
              error: protocolError("UPGRADE_REQUIRED", "no common protocol version"),
              supported: SUPPORTED_VERSIONS,
            }),
          ];
        }
        return [
          HelloAck.create({
            negotiated_version: negotiated,
            machine_id: this.machineId,
            server_ts: nowIso(),
          }),
        ];
      }
      case "debug.echo": {
        const cached = this.store.getCommandResult(msg.command_id);
        if (cached !== undefined) {
          return [
            DebugEcho.createOk(msg.command_id, cached as { echoed: string }, { duplicate: true }),
          ];
        }
        const result = { echoed: msg.payload.text };
        this.store.append(this.stream, [
          {
            event_id: newEventId(),
            type: DebugEchoed.type,
            ts: nowIso(),
            payload: { text: msg.payload.text, command_id: msg.command_id },
          },
        ]);
        this.store.putCommandResult(msg.command_id, result, 60_000);
        return [DebugEcho.createOk(msg.command_id, result)];
      }
      case "sync.replay": {
        const events = this.store.read(msg.payload.stream, msg.payload.since, msg.payload.limit);
        return [
          SyncReplay.createOk(msg.command_id, {
            events,
            head_seq: this.store.headSeq(msg.payload.stream),
          }),
        ];
      }
      default:
        return [];
    }
  }
}

/** Client helper: send, parse the response through the same protocol schemas. */
function roundTrip(controller: MiniController, message: unknown): KnownMessage[] {
  return controller.handle(JSON.stringify(message)).map((raw) => {
    const parsed = parseInbound(raw);
    if (!parsed.ok) throw new Error(`client failed to parse response: ${parsed.error.message}`);
    return parsed.value;
  });
}

describe("S0 gate: command round-trip with validation, sequences, replay, idempotency", () => {
  test("full scenario", () => {
    const controller = new MiniController();

    // 1. handshake negotiates version 1
    const [ack] = roundTrip(
      controller,
      Hello.create({ protocol: SUPPORTED_VERSIONS, device_id: "phone_1" }),
    );
    expect(ack?.type).toBe("hello_ack");
    if (ack?.type === "hello_ack") expect(ack.payload.negotiated_version).toBe(1);

    // 2. incompatible client is rejected with UPGRADE_REQUIRED
    const [reject] = roundTrip(
      controller,
      Hello.create({ protocol: { min: 2, max: 3 }, device_id: "phone_old" }),
    );
    expect(reject?.type).toBe("hello_reject");
    if (reject?.type === "hello_reject") expect(reject.payload.error.code).toBe("UPGRADE_REQUIRED");

    // 3. command executes: validated, event appended with seq 1, result returned
    const echo = DebugEcho.createRequest({ text: "hello laptop" });
    const [result] = roundTrip(controller, echo);
    expect(result?.type).toBe("debug.echo.result");
    if (result?.type === "debug.echo.result" && result.payload.status === "ok") {
      expect(result.payload.result.echoed).toBe("hello laptop");
      expect(result.payload.duplicate).toBe(false);
    }

    // 4. replay from 0 sees exactly one event with seq 1
    const [replay1] = roundTrip(
      controller,
      SyncReplay.createRequest({ stream: "proj_demo", since: 0, limit: 100 }),
    );
    if (replay1?.type === "sync.replay.result" && replay1.payload.status === "ok") {
      expect(replay1.payload.result.events).toHaveLength(1);
      expect(replay1.payload.result.events[0]?.seq).toBe(1);
      expect(replay1.payload.result.events[0]?.type).toBe("debug.echoed");
      expect(replay1.payload.result.head_seq).toBe(1);
    } else {
      throw new Error("replay1 failed");
    }

    // 5. idempotent retry: same command_id → same result, duplicate=true, NO new event
    const [retry] = roundTrip(controller, echo);
    if (retry?.type === "debug.echo.result" && retry.payload.status === "ok") {
      expect(retry.payload.duplicate).toBe(true);
      expect(retry.payload.result.echoed).toBe("hello laptop");
    } else {
      throw new Error("retry failed");
    }
    expect(controller.store.headSeq("proj_demo")).toBe(1);

    // 6. a second distinct command appends seq 2; incremental replay since=1 returns only it
    const [second] = roundTrip(controller, DebugEcho.createRequest({ text: "again" }));
    expect(second?.type).toBe("debug.echo.result");
    const [replay2] = roundTrip(
      controller,
      SyncReplay.createRequest({ stream: "proj_demo", since: 1, limit: 100 }),
    );
    if (replay2?.type === "sync.replay.result" && replay2.payload.status === "ok") {
      expect(replay2.payload.result.events.map((e) => e.seq)).toEqual([2]);
      expect(replay2.payload.result.head_seq).toBe(2);
    } else {
      throw new Error("replay2 failed");
    }

    // 7. garbage in → schema-validated rejection, never a crash
    const [bad] = controller
      .handle("{not json")
      .map((raw) => JSON.parse(raw) as { payload: { error: { code: string } } });
    expect(bad?.payload.error.code).toBe("INVALID_PAYLOAD");

    controller.store.close();
  });
});
