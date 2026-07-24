// Bundle browser-ESM vendor files for the renderer.
//
// The renderer loads views as native ES modules with an importmap —
// marked and dompurify ship browser-ready single-file ESM builds, but
// highlight.js's `es/` entry re-exports from CommonJS (dual-package shim),
// which a browser cannot load. esbuild flattens it into one real ESM file.
// Runs from postinstall; output is gitignored.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(HERE, "node_modules", "highlight.js", "es", "common.js")],
  bundle: true,
  format: "esm",
  outfile: join(HERE, "renderer", "vendor", "highlight.mjs"),
  logLevel: "warning",
});
console.log("vendor: renderer/vendor/highlight.mjs bundled");
