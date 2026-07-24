// Remove non-distributable electron-builder side products from dist/.
//
// The release workflow uploads `dist/oas-desktop-*` as the platform artifact
// (contract: only the distributable files). electron-builder also emits
// *.blockmap (differential-update metadata — the app has no updater) and
// builder-*.yml under the same prefix-adjacent space; strip everything that
// is not an installer/archive so the glob stays pure.
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const KEEP = /\.(dmg|zip|AppImage|deb)$/;
let removed = 0;
for (const f of readdirSync(DIST)) {
  if (f.startsWith("oas-desktop-") && !KEEP.test(f)) { rmSync(join(DIST, f)); removed++; }
  if (/^(builder-.*\.ya?ml|latest.*\.ya?ml)$/.test(f)) { rmSync(join(DIST, f)); removed++; }
}
console.log(`clean-dist: removed ${removed} non-distributable file(s)`);
