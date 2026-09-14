import {
  createHandworkAgent as createWasmAgent,
  createHandworkTerminal as createWasmTerminal,
  encodeXtermKeyEvent,
  handworkSdkApiVersion,
  listModels,
  supportsJspi,
  xtermAdapter,
} from "./handwork-sdk.js";

export { encodeXtermKeyEvent, handworkSdkApiVersion, listModels, supportsJspi, xtermAdapter };
export const libhandworkApiVersion = 2;

const defaultCoreWasm = new URL("./handwork-core.wasm", import.meta.url).href;
const defaultTermWasm = new URL("./handwork-term.wasm", import.meta.url).href;

export function createHandworkAgent(options = {}) {
  return createWasmAgent({ ...options, wasm: options.wasm ?? defaultCoreWasm });
}

export function createHandworkTerminal(options = {}) {
  return createWasmTerminal({ ...options, wasm: options.wasm ?? defaultTermWasm });
}
