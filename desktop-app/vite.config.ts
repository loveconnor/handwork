import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async ({ mode }) => {
  const stable = mode === "stable";

  return {
    plugins: [
      {
        name: "honestui-catalog-tree-shaking",
        apply: "build",
        enforce: "pre",
        transform(code, id) {
          if (!/[/\\]honestui[/\\]dist[/\\](?:icons|logos)\.js$/.test(id))
            return;
          // Generated debug-name assignments keep the entire catalog alive.
          // Component creation is pure; debug names are unnecessary in a bundle.
          return {
            code: code
              .replace(
                /React\.forwardRef\(/g,
                "/* @__PURE__ */ React.forwardRef(",
              )
              .replace(/^\w+\.displayName = "[^"]+";\r?\n/gm, ""),
            map: null,
          };
        },
      },
      react(),
      tailwindcss(),
    ],
    worker: { format: "es" },
    resolve: {
      alias: [
        ...(mode.startsWith("benchmark")
          ? [
              {
                find: /^@tauri-apps\/api\/core$/,
                replacement: new URL(
                  "./tests/browser/tauriFixture.ts",
                  import.meta.url,
                ).pathname,
              },
            ]
          : []),
        ...(mode === "benchmark-profile"
          ? [{ find: "react-dom/client", replacement: "react-dom/profiling" }]
          : []),
      ],
    },
    clearScreen: false,
    build: {
      rollupOptions: {
        // The quick composer panel loads its own page so it does not boot the
        // whole workspace.
        input: {
          main: "index.html",
          quickComposer: "quick-composer.html",
          monoChat: "handwork-chat.html",
          ...(mode.startsWith("benchmark")
            ? { workspaceBenchmark: "tests/browser/workspace-performance.html" }
            : {}),
        },
      },
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: stable
        ? false
        : host
          ? {
              protocol: "ws",
              host,
              port: 1421,
            }
          : undefined,
      watch: {
        ignored: stable ? ["**/*"] : ["**/src-tauri/**"],
      },
    },
  };
});
