// Probe `copilot --acp` initialize response for the loadSession capability.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const cmd = path.join(process.env.APPDATA ?? "", "npm", "copilot.cmd");
const child = spawn(`"${cmd}" --acp`, [], { shell: true, cwd: os.homedir() });
child.stdout.setEncoding("utf8");
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        console.log("INIT RESULT:", JSON.stringify(msg.result, null, 2));
        child.kill();
        process.exit(0);
      }
    } catch {
      /* partial line */
    }
  }
});
child.stdin.write(
  `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } })}\n`,
);
setTimeout(() => {
  console.error("timeout; stderr tail follows");
  process.exit(1);
}, 30000);
