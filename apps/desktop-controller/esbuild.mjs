import { build } from "esbuild";

// Single-file controller for the zero-dependency install path: the VS Code
// extension downloads this + the three native packages and runs it on the
// editor's own Node runtime. Everything pure-JS is inlined.
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/controller.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@lydell/node-pty", "@parcel/watcher", "koffi"],
  banner: {
    // bundled CJS deps require() node builtins — give the ESM output a real require
    js: "import { createRequire as __rdcCreateRequire } from 'node:module'; const require = __rdcCreateRequire(import.meta.url);",
  },
  sourcemap: false,
  logLevel: "info",
});
