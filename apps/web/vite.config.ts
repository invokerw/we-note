import { defineConfig } from "vite";
export default defineConfig(({ mode }) =>
  mode === "desktop"
    ? {
        root: "../client/ui",
        base: "./",
        build: { outDir: "../dist", emptyOutDir: true, assetsDir: "static" },
      }
    : { build: { assetsDir: "static" } },
);
