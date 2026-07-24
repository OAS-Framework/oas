// OAS Desktop — electron-builder configuration (v0.18.0 public matrix).
//
// Contract (desktop-dist): macOS arm64/x64 DMG+ZIP, Linux x64 AppImage+DEB,
// artifacts named oas-desktop-* under packages/desktop/dist/ (the release
// workflow uploads `desktop-<os>-<arch>` from that glob). 0.18.0 ships
// UNSIGNED and NOT notarized — no credentials exist; certificate
// auto-discovery is disabled (CSC_IDENTITY_AUTO_DISCOVERY=false in CI and
// identity:null here so local builds behave identically). Linux declares
// tmux as a package dependency (DEB) and documents it for AppImage.
//
// A JS config (not JSON) so the file can carry these binding comments and
// compute nothing — keep it static and reviewable.
module.exports = {
  appId: "ai.oas.desktop",
  productName: "OAS Desktop",
  // artifactName pins the seam: dist/oas-desktop-<version>-<os>-<arch>.<ext>
  // — the workflow globs dist/oas-desktop-* and must never catch stray
  // builder metadata; every artifact below inherits this name.
  artifactName: "oas-desktop-${version}-${os}-${arch}.${ext}",
  directories: { output: "dist" },
  // Ship exactly the app: sources + production deps. The test tree, harness,
  // and builder config itself stay out of the package (inventory-tested).
  files: [
    "main.mjs",
    "preload.cjs",
    "api-url.mjs",
    "cli-adapter.mjs",
    "cli-locator.mjs",
    "server-compat.mjs",
    "server-host.mjs",
    "tmux-target.mjs",
    "workspace-registry.mjs",
    "server/**/*",
    "renderer/**/*",
    "package.json",
    "!renderer/harness.html",
    "!renderer/harness-server.mjs",
    "!test/**",
    "!build-vendor.mjs",
    "!electron-builder.config.cjs",
    "!**/*.test.mjs",
    "!**/.DS_Store",
  ],
  // node-pty is a native dep: electron-builder runs its own beforeBuild
  // rebuild against the bundled Electron ABI (npmRebuild default true);
  // asarUnpack keeps the prebuilt spawn-helper executable on disk where
  // posix_spawnp can exec it (inside asar it cannot).
  asarUnpack: ["**/node_modules/node-pty/**"],
  npmRebuild: true,
  // Fresh `npm ci` can deliver node-pty's prebuilt spawn-helper WITHOUT the
  // execute bit (posix_spawnp then fails in the packaged app — release
  // blocker found by the integration gate). Restore it deterministically on
  // the PACKED output; never rely on working-tree chmod residue.
  afterPack: "scripts/after-pack.cjs",
  mac: {
    // Targets WITHOUT pinned arch: electron-builder builds the HOST arch by
    // default, so each CI matrix job (macos-14=arm64, macos-13=x64) produces
    // exactly its own pair and the desktop-<os>-<arch> artifact stays pure.
    // Cross-arch fallback (if the x64 runner disappears):
    //   npm run dist -- --x64   on an arm64 runner.
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    // UNSIGNED (0.18.0): no Developer ID exists. identity:null disables
    // signing entirely — release notes and docs state the Gatekeeper
    // implications; nothing may claim signing or notarization.
    identity: null,
  },
  linux: {
    target: ["AppImage", "deb"],
    category: "Development",
    // tmux is a hard runtime prerequisite (terminal attach path).
    // DEB declares it; AppImage cannot declare deps — docs carry it.
    synopsis: "Control panel for OAS agent deployments",
    description: "OAS Desktop — roster, brain and terminal access for OAS agent deployments. Requires tmux and an installed @oas-framework/oas CLI for lifecycle actions.",
  },
  deb: {
    depends: ["tmux"],
  },
  dmg: {
    // default layout; no code that would require signing
    writeUpdateInfo: false,
  },
  // No publish config: CI uploads artifacts itself; electron-builder must
  // never attempt a GitHub publish from a build job.
  publish: null,
};
