import { buildRelay } from "./server.ts";

const token = process.env.RELAY_TOKEN ?? "";
if (token.length < 16) {
  console.error("RELAY_TOKEN env var (min 16 chars) is required");
  process.exit(1);
}
const port = Number(process.env.RELAY_PORT ?? 8443);

const app = await buildRelay({ token });
await app.listen({ port, host: "0.0.0.0" });
console.log(`rdc relay listening on :${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
