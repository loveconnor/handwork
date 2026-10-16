export function rendererPolicy(packaged) {
  // Honest Prose Syntax uses Shiki's Oniguruma WebAssembly engine. This permits
  // WASM compilation without permitting JavaScript eval or external scripts.
  return "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'" + (packaged ? '' : " 'unsafe-inline'") +
    "; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tiles.openfreemap.org https://basemap.nationalmap.gov; font-src 'self' data:; connect-src 'self' https://tiles.openfreemap.org https://basemap.nationalmap.gov" +
    (packaged ? '' : ' ws://127.0.0.1:5173') + "; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
}
