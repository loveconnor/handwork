const path = require("node:path");
// SDK 57 renames DOM assets for native export without rewriting split-chunk
// dependencies. Keep each offline DOM reply bundle self-contained.
process.env.EXPO_NO_BUNDLE_SPLITTING = "1";
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
// Chat UI is shared with the desktop. Watch that source and keep the web
// renderer on this app's React version when following imports outside mobile/.
config.watchFolders = [path.resolve(__dirname, "..")];
config.resolver.nodeModulesPaths = [
  path.join(__dirname, "node_modules"),
  path.resolve(__dirname, "../node_modules"),
];
config.resolver.resolveRequest = (context, name, platform) =>
  context.resolveRequest(
    /^(react|react-dom)(\/|$)/.test(name)
      ? { ...context, originModulePath: path.join(__dirname, "package.json") }
      : context,
    name,
    platform,
  );
module.exports = config;
