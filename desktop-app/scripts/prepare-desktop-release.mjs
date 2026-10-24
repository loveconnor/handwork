// Fail early instead of silently publishing only one platform or unsigned updates.
for (const key of ['TAURI_SIGNING_PRIVATE_KEY', 'MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) {
  if (!process.env[key]) throw new Error(`Configure the ${key} GitHub Actions secret in loveconnor/handwork before releasing desktop apps.`);
}
