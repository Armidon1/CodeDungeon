import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";

// - `npm run dev`        gioco in sviluppo su http://localhost:5173, collegato al ponte su :7337
// - `npm run build:game` gioco compilato in dist/game, servito dal ponte
// - `npm run build:demo` un unico file HTML con il progetto d'esempio incorporato, senza ponte
export default defineConfig(({ mode }) => {
  const demo = mode === "demo";
  return {
    root: fileURLToPath(new URL("./src/game", import.meta.url)),
    base: "./",
    define: { __DEMO__: JSON.stringify(demo) },
    plugins: demo ? [viteSingleFile()] : [],
    server: { port: 5173, fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] } },
    build: {
      outDir: fileURLToPath(new URL(demo ? "./dist/demo" : "./dist/game", import.meta.url)),
      emptyOutDir: true,
      assetsInlineLimit: demo ? 100_000_000 : 4096,
    },
  };
});
