import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import wabt from "wabt";
import { zipSync } from "fflate";
export async function pack(directory) {
  const compiler = await wabt();
  const wat = await readFile(join(directory, "core.wat"), "utf8");
  const module = compiler.parseWat("core.wat", wat);
  try {
    module.validate();
    return zipSync(
      {
        "manifest.json": await readFile(join(directory, "manifest.json")),
        "core.wasm": module.toBinary({}).buffer,
      },
      { mtime: new Date(2000, 0, 1) },
    );
  } finally {
    module.destroy();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [, , directory, output] = process.argv;
  if (!directory || !output)
    throw Error(
      "Usage: node plugin-sdk/pack.mjs <source-directory> <output.zip>",
    );
  await writeFile(output, await pack(directory));
}
