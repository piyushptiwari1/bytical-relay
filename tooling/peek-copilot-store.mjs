// Read-only peek into the Copilot CLI session store (schema discovery).

import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(path.join(os.homedir(), ".copilot", "session-store.db"), {
  readOnly: true,
});
const sessions = db
  .prepare("SELECT id, cwd, summary, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 5")
  .all();
for (const row of sessions) console.log("SESSION", JSON.stringify(row));
const turns = db
  .prepare(
    "SELECT session_id, turn_index, substr(user_message,1,70) AS u, substr(assistant_response,1,70) AS a FROM turns ORDER BY timestamp DESC LIMIT 4",
  )
  .all();
for (const row of turns) console.log("TURN", JSON.stringify(row));
