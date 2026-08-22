// Monorepo Metro config (Expo SDK 57): pnpm workspace resolution + node-core
// shims so any stray node-builtin import resolves to an inert module.
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

module.exports = config;
