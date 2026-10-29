import manifest from '../package.json' with { type: 'json' };

// Launching main.mjs directly makes Electron's app.getVersion() report its own version.
export const appVersion = manifest.version;
