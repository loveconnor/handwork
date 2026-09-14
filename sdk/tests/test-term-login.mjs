#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

// Embedded terminals delegate subscription authentication to their host.
const source = await readFile(new URL("../term-demo.html", import.meta.url), "utf8");
assert.match(source, /HANDWORK_AUTH_MODE: "host-managed"/);
assert.match(source, /fetch:.*\/api\/provider/);
assert.doesNotMatch(source, /localStorage\.getItem\("HANDWORK_API_KEY"\)/);
console.log("terminal demo delegates subscription authentication to host fetch");
