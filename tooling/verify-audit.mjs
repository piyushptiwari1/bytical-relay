import path from "node:path";
import { AuditLog } from "../apps/desktop-controller/src/audit-log.ts";

const dbPath = path.join(process.env.LOCALAPPDATA ?? "", "rdc", "audit.db");
const log = new AuditLog(dbPath);
console.log("audit chain:", JSON.stringify(log.verify()));
