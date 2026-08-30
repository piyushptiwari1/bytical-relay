import { buildAnalytics } from "./analytics.ts";

const token = process.env.ANALYTICS_TOKEN ?? "";
if (token.length < 16) {
  console.error("ANALYTICS_TOKEN env var (min 16 chars) is required");
  process.exit(1);
}
const port = Number(process.env.ANALYTICS_PORT ?? 8444);

const app = buildAnalytics({
  token,
  dbPath: process.env.ANALYTICS_DB ?? "/opt/rdc/analytics.db",
  ...(process.env.ANALYTICS_PUBLIC_ORIGIN
    ? { publicOrigin: process.env.ANALYTICS_PUBLIC_ORIGIN }
    : {}),
});
await app.listen({ port, host: "127.0.0.1" });
console.log(`rdc-analytics listening on 127.0.0.1:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
