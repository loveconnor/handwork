import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./desktop", import.meta.url)),
  base: "./",
  define: { "process.env.NEXT_PUBLIC_APP_URL": JSON.stringify("https://ai.honestui.com") },
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  optimizeDeps: {
    // Both Markdown and GenUI must retain their relative syntax-worker URL.
    exclude: ["honestui/ai/markdown", "honestui/genui", "honestui/syntax/react", "honestui/charts"],
    // Prebundle their nested dependencies before a saved chat opens the lazy view.
    include: [
      "react-markdown", "next-themes", "react-day-picker", "maplibre-gl",
      "@tanstack/react-table", "@tanstack/react-virtual",
      "use-sync-external-store/shim", "use-sync-external-store/shim/with-selector",
      // Keep the core, component and renderer registries in one ECharts module graph.
      "echarts/core", "echarts/charts", "echarts/components", "echarts/renderers",
      // The editor loads each language when a file needs it. Found that late, a dependency makes Vite
      // bundle again, and a page already open loses the modes it had not yet loaded.
      "@codemirror/autocomplete", "@codemirror/lang-cpp", "@codemirror/lang-css", "@codemirror/lang-html", "@codemirror/lang-java",
      "@codemirror/lang-javascript", "@codemirror/lang-json", "@codemirror/lang-less", "@codemirror/lang-markdown", "@codemirror/lang-php",
      "@codemirror/lang-python", "@codemirror/lang-rust", "@codemirror/lang-sass", "@codemirror/lang-sql", "@codemirror/lang-vue",
      "@codemirror/lang-xml", "@codemirror/lang-yaml", "@replit/codemirror-lang-svelte",
      ...["clike", "dockerfile", "go", "javascript", "lua", "perl", "powershell", "properties", "protobuf", "r", "ruby", "shell", "swift", "toml"].map(mode => `@codemirror/legacy-modes/mode/${mode}`),
    ],
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "../dist", emptyOutDir: true },
});
