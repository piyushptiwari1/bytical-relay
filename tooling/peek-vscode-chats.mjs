// Inspect VS Code chat session file shape (keys + first request/response snippet).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const storage = path.join(process.env.APPDATA ?? "", "Code/User/workspaceStorage");
outer: for (const hash of readdirSync(storage)) {
  const dir = path.join(storage, hash, "chatSessions");
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    continue;
  }
  for (const name of files) {
    const file = path.join(dir, name);
    const session = JSON.parse(readFileSync(file, "utf8"));
    const req = session.requests?.[0];
    if (!req) continue;
    const ws = JSON.parse(readFileSync(path.join(storage, hash, "workspace.json"), "utf8"));
    console.log("WORKSPACE:", ws.folder ?? ws.workspace ?? "?");
    console.log("FILE:", name, "requests:", session.requests.length);
    console.log("TOP KEYS:", Object.keys(session).join(", "));
    console.log("REQ KEYS:", Object.keys(req).join(", "));
    console.log("REQ TEXT:", JSON.stringify(req.message?.text ?? req.message).slice(0, 140));
    const resp = req.response;
    console.log("RESP is array:", Array.isArray(resp), "len:", resp?.length);
    if (Array.isArray(resp)) {
      console.log("RESP[0] keys:", Object.keys(resp[0] ?? {}).join(", "));
      const text = resp
        .map((r) => (typeof r.value === "string" ? r.value : ""))
        .join("")
        .slice(0, 140);
      console.log("RESP TEXT:", JSON.stringify(text));
    }
    console.log("customTitle:", session.customTitle);
    break outer;
  }
}
