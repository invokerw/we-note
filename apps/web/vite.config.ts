import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Already-open tabs can still import the preceding release's hashed chunks.
function keepPreviousWebAssets(): Plugin {
  return {
    name: "wenote-previous-web-assets",
    apply: "build",
    async writeBundle({ dir }, bundle) {
      if (!dir) return;
      const marker = join(dir, ".web-assets.json");
      const current = Object.keys(bundle).filter((name) => name.startsWith("static/")).sort();
      let previous: string[] | undefined;
      try {
        previous = JSON.parse(await readFile(marker, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const serialized = JSON.stringify(current);
      if (serialized === JSON.stringify(previous)) return;
      if (previous) {
        const keep = new Set([...previous, ...current]);
        const directory = join(dir, "static");
        for (const file of await readdir(directory, { withFileTypes: true })) {
          if (file.isFile() && /-[\w-]{8}\.\w+$/.test(file.name) && !keep.has(`static/${file.name}`))
            await unlink(join(directory, file.name));
        }
      }
      await writeFile(`${marker}.tmp`, serialized);
      await rename(`${marker}.tmp`, marker);
    },
  };
}

export default defineConfig(({ mode }) =>
  mode === "desktop"
    ? {
        root: "../client/ui",
        base: "./",
        build: { outDir: "../dist", emptyOutDir: true, assetsDir: "static" },
      }
    : { build: { emptyOutDir: false, assetsDir: "static" }, plugins: [keepPreviousWebAssets()] },
);
