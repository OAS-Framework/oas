// electron-builder afterPack hook — restore node-pty spawn-helper exec bits.
//
// npm can drop the execute permission on node-pty's prebuilt `spawn-helper`
// binaries during a fresh `npm ci` (soul lesson: every pty.spawn then fails
// with "posix_spawnp failed."). A local dev build often masks this because
// the Electron rebuild produces an executable build/Release/spawn-helper —
// but the packaged app also ships the prebuilds/ helpers, and on a clean CI
// install they arrive 0644. Fix it IN PACKAGING, deterministically, on the
// packed output — never rely on the developer's working tree having been
// chmodded.
"use strict";
const { readdirSync, statSync, chmodSync, existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  // The unpacked app dir differs per platform: mac has the .app bundle.
  const roots = [];
  if (context.electronPlatformName === "darwin") {
    for (const e of readdirSync(context.appOutDir)) {
      if (e.endsWith(".app")) roots.push(join(context.appOutDir, e, "Contents", "Resources"));
    }
  } else {
    roots.push(join(context.appOutDir, "resources"));
  }
  let fixed = 0;
  for (const res of roots) {
    const pty = join(res, "app.asar.unpacked", "node_modules", "node-pty");
    if (!existsSync(pty)) continue;
    const candidates = [join(pty, "build", "Release", "spawn-helper")];
    const prebuilds = join(pty, "prebuilds");
    if (existsSync(prebuilds)) {
      for (const d of readdirSync(prebuilds)) candidates.push(join(prebuilds, d, "spawn-helper"));
    }
    for (const helper of candidates) {
      if (!existsSync(helper)) continue;
      const mode = statSync(helper).mode;
      if (!(mode & 0o111)) { chmodSync(helper, 0o755); fixed++; }
    }
  }
  if (fixed) console.log(`afterPack: restored exec bit on ${fixed} spawn-helper(s)`);
};
