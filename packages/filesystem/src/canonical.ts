import { realpath } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "@rdc/shared";

/** Windows path-traversal guard — the checklist from PLAN §7/§38. */

const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we reject
const CONTROL_CHARS = /[\u0000-\u001f]/;

export function normalizeRelPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

export interface ResolvedPath {
  abs: string;
  rel: string;
}

/**
 * Sole gate for turning an untrusted relative path into an absolute path inside
 * a project root. Rejects: absolute/UNC/drive paths, `..`, ADS (`file:stream`),
 * reserved device names (CON, NUL, COM1…), trailing dots/spaces, control chars,
 * and symlink/junction escapes (realpath re-check when the target exists).
 */
export async function resolveInsideProject(
  rootAbs: string,
  requested: string,
): Promise<Result<ResolvedPath, Error>> {
  if (path.isAbsolute(requested) || /^[a-zA-Z]:/.test(requested) || requested.startsWith("\\\\")) {
    return err(new Error("absolute paths are not allowed"));
  }
  const rel = normalizeRelPath(requested);
  if (rel.length === 0) return err(new Error("empty path"));
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return err(new Error(`illegal path segment: "${segment}"`));
    }
    if (segment.includes(":")) return err(new Error("NTFS alternate data streams are not allowed"));
    if (/[. ]$/.test(segment)) return err(new Error("trailing dots/spaces are not allowed"));
    if (RESERVED_NAMES.test(segment)) return err(new Error(`reserved device name: ${segment}`));
    if (CONTROL_CHARS.test(segment)) return err(new Error("control characters are not allowed"));
  }
  const abs = path.join(rootAbs, ...rel.split("/"));
  const lexical = path.relative(rootAbs, abs);
  if (lexical.startsWith("..") || path.isAbsolute(lexical)) {
    return err(new Error("path escapes project root"));
  }
  try {
    const rootReal = await realpath(rootAbs);
    const targetReal = await realpath(abs);
    const relReal = path.relative(rootReal, targetReal);
    if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
      return err(new Error("path escapes project root via symlink/junction"));
    }
  } catch {
    // target does not exist yet — lexical containment already verified
  }
  return ok({ abs, rel });
}

/** Deny-overlay for secrets even inside projects (PLAN §7): view requires explicit approval. */
const SENSITIVE_BASENAMES = [
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\..+)?$/i,
  /^credentials\.json$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
];

export function isSensitivePath(relPath: string): boolean {
  const base = normalizeRelPath(relPath).split("/").at(-1) ?? "";
  return SENSITIVE_BASENAMES.some((re) => re.test(base));
}
