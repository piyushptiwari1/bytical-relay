// Monorepo Metro config (Expo SDK 57): pnpm workspace resolution + node-core
// shims so libsodium-wrappers' UMD environment probes bundle cleanly.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
const empty = path.resolve(projectRoot, "src/shims/empty.js");
config.resolver.extraNodeModules = {
  crypto: empty,
  fs: empty,
  path: empty,
  stream: empty,
};

// libsodium-wrappers' ESM dist is broken (relative import "./libsodium.mjs"
// does not exist in the published package). Force the CJS/UMD builds, same
// workaround as @rdc/security/node-init.ts uses for Node. CJS require.resolve
// follows the "require" exports condition, which points at the working build.
const wrappersCjs = require.resolve("libsodium-wrappers", {
  paths: [projectRoot],
});
const sodiumCjs = require.resolve("libsodium", {
  paths: [path.dirname(wrappersCjs)],
});
const forced = { "libsodium-wrappers": wrappersCjs, libsodium: sodiumCjs };
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const hit = forced[moduleName];
  if (hit) {
    return { type: "sourceFile", filePath: hit };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
