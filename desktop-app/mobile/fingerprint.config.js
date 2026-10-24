/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  // Native folders and compiled libraries are regenerated on EAS. Hash their
  // source inputs so local OTA publishing matches a clean cloud build.
  ignorePaths: [
    "ios",
    "ios/**/*",
    "android",
    "android/**/*",
    "modules/handwork-link/ios/*.xcframework",
    "modules/handwork-link/ios/*.xcframework/**/*",
    "modules/handwork-link/android/src/main/jniLibs",
    "modules/handwork-link/android/src/main/jniLibs/**/*",
  ],
  extraSources: [
    { type: "file", filePath: "../Cargo.toml", reasons: ["handworkRust"] },
    { type: "file", filePath: "../Cargo.lock", reasons: ["handworkRust"] },
    {
      type: "dir",
      filePath: "../crates/mobile-link",
      reasons: ["handworkRust"],
    },
    {
      type: "file",
      filePath: "scripts/build-native-link.mjs",
      reasons: ["handworkRust"],
    },
    {
      type: "file",
      filePath: "scripts/eas-build-pre-install.mjs",
      reasons: ["handworkRust"],
    },
  ],
};
