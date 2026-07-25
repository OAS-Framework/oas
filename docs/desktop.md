# OAS Desktop

The OAS Desktop app is the control panel for OAS deployments: the agent
roster and hierarchy, brain/markdown/task/state views, and real terminal
attach to running agents' tmux sessions. With a compatible `oas` CLI
installed it can also spawn agents from the Soul roster.

## Install

Download the installer for your platform from the
[GitHub Release](https://github.com/OAS-Framework/oas/releases) assets:

| Platform | Artifacts | Notes |
| --- | --- | --- |
| macOS arm64 (Apple Silicon) | DMG + ZIP | ad-hoc signed — see below |
| macOS x64 (Intel) | DMG + ZIP | ad-hoc signed — see below |
| Linux x64 | AppImage + DEB | requires `tmux` |

**Windows and Linux arm64 are not supported in 0.18.x.**

Verify downloads against the release's `SHA256SUMS.txt`. GitHub
build-provenance attestations are published for every asset
(`gh attestation verify <file> --repo OAS-Framework/oas`).

### macOS: ad-hoc signed build

The macOS installers are **ad-hoc signed — not Developer ID signed and not
notarized** (no Apple signing credentials exist; nothing about this release
claims identified-developer trust). The app bundle carries a complete,
valid ad-hoc signature — every nested helper and framework is signed and
the bundle passes `codesign --verify --deep --strict` — but ad-hoc
signatures carry no identity Gatekeeper can trust, so it will still block
the first launch of a downloaded (quarantined) copy:

- Right-click the app → **Open** → **Open** (once; subsequent launches are
  normal), or
- `xattr -dr com.apple.quarantine "/Applications/OAS Desktop.app"`.

### Linux: prerequisites

`tmux` is required for the integrated terminal — the app attaches to your
agents' tmux sessions. Roster, brain, Markdown and CLI features work without
it, but opening a terminal will fail until tmux is installed. The DEB
declares the dependency; for the AppImage install it yourself
(`apt install tmux`, `dnf install tmux`, …) and verify with `tmux -V`.

### The `oas` CLI (for Spawn)

Reads — roster, hierarchy, brain, files, terminals — work with no CLI at
all. Spawning agents runs through an installed `oas` CLI with Desktop API
v1:

```bash
npm install -g @oas-framework/oas@0.18.2
```

Desktop 0.18 accepts CLI versions `>=0.18.0 <0.19.0` (released versions
only; prereleases are rejected). The app discovers the CLI automatically
(your PATH, the npm global prefix, a login shell) and re-probes on launch,
app focus, and Retry. Until a compatible CLI is verified, the Soul roster's
**Spawn** buttons are disabled behind one card showing what was detected,
what is required, **Choose oas…** (pick the binary yourself — the choice
persists), **Retry**, a docs link, and the copyable install command. The
app never installs anything itself. (Memory harvest runs through the same
CLI boundary in the backend; it has no dedicated button in this release.)

The probe/mutation contract is specified in
[desktop-cli-api.md](desktop-cli-api.md).

## Opening a workspace

The app starts on the directory it was launched with (its own folder by
default). To view a deployment, open the workspace switcher in the sidebar
and choose **Add workspace → Browse**, then point it at an OAS workspace —
a directory containing `agents/`, or `local-agents/` for machine-local
souls, or a team scope whose `oas-config.yaml` declares `team:`. Team scopes
show every member repo's agents under one roster with a workspace switcher.
Added workspaces are remembered and offered as suggestions next time.

Local souls (uncommitted, machine-local agents under `local-agents/`) are
first-class: they appear in the roster with a `local` chip, their brains
and knowledge render, and they spawn like any other soul. Launch flags for
scripted use: `--dir <workspace>` and `OAS_DESKTOP_PORT`.

## Migrating from the web panel / TUI pane

0.18.2 removes the legacy `oas.web` browser panel, `oas pane`, and the
`@oas-framework/oas/control-pane` export. The Desktop app replaces all
three. Migration:

1. Update the CLI everywhere: `npm install -g @oas-framework/oas@0.18.2`.
2. Run `oas doctor` at each workspace scope and follow its guidance to
   remove stale `oas.web` config entries, locks, and installed artifacts.
3. Install the Desktop app (above) and open your workspace.

The full breaking-change list is in the
[v0.18.2 release notes](release-notes/v0.18.2.md).

## Security posture

- The bundled backend binds **127.0.0.1 only** and guards against DNS
  rebinding (loopback Host on every request, loopback Origin on POSTs).
  Do not expose it: it can type into your agent terminals.
- The app never imports framework code from a checkout and accepts no
  framework-root environment override; deployments are read with an
  app-owned read-only reader. All lifecycle mutations go through the
  installed CLI via `execFile` with an absolute binary — never a shell.
- Task text for spawns travels via an owner-only (0600) tempfile, never
  argv. Harvest always runs in the server-verified instance home.
- Workspace content is treated as untrusted: symlinked directories never
  widen the file API, and capability packages cannot read outside their
  own tree.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Compatible oas CLI required" card | No CLI, or version outside `>=0.18.0 <0.19.0`. Install/update, or **Choose oas…** to point at the right binary; **Retry** re-probes. Spawn is disabled until a compatible CLI is verified. |
| Spawn disabled, no card | The probe hasn't settled yet (transient, resolves in ms). If it persists, the backend is unreachable — restart the app. |
| Terminals fail to open ("could not attach") | tmux missing, or no live session for that instance. Install tmux (`tmux -V`); check `tmux ls`. |
| macOS "app is damaged / can't be opened" | Ad-hoc-signed (not notarized) build + quarantine. Right-click → Open, or clear the quarantine attribute (above). If it persists, verify the bundle: `codesign --verify --deep --strict --verbose=2 "/Applications/OAS Desktop.app"` — a non-zero exit means a broken artifact, report it. |
| Roster empty | The opened directory isn't an OAS workspace (needs `agents/` or `local-agents/`, or a team scope). Use the workspace switcher → Add workspace to select the right root. |

For bugs, attach the terminal output of the app (`OAS Desktop` prints
server and CLI-discovery logs to stdout) and your platform/arch.

## Release verification ownership

Installer CI gates what headless runners can prove reliably for every
published platform/architecture: electron-builder completes, the expected
DMG/ZIP/AppImage/DEB artifacts exist, both packaged macOS `.app` bundles
pass strict deep codesign verification of their complete ad-hoc signatures
(`codesign --verify --deep --strict`), node-pty's packaged `spawn-helper` is
executable, and node-pty loads and spawns under the packaged Electron ABI.
The macOS x64 leg cross-builds on macos-14 and installs Rosetta 2 so that its
x64 Electron + node-pty ABI probe really executes; a wrong-architecture
native module fails that leg.

CI does **not** gate the packaged GUI launch: ad-hoc-signed, non-notarized
Electron apps do not
have a reliable interactive windowserver in headless CI. Post-publish launch
acceptance is therefore owned by the operator/maintainer, using the actual
released installers (not a source checkout):

1. Verify the asset checksum/attestation, install it outside the source tree,
   and on macOS use right-click → **Open** for the Gatekeeper step (ad-hoc
   signatures carry no identified-developer identity).
2. Launch OAS Desktop and open a real deployment; verify roster, brain and
   Markdown reads.
3. Attach an existing tmux terminal, confirm input/output, and close the tab
   (the durable tmux window must survive).
4. Verify the released global CLI is detected and Spawn is enabled; hide or
   mismatch the CLI and confirm reads/terminal still work while Spawn disables
   with recovery guidance.
5. Repeat per published architecture where hardware is available. In
   particular, launch-check macOS x64 on an Intel Mac if one is available;
   CI's Rosetta ABI probe is the native-module proof, while this is the actual
   shipped-installer/user-launch proof.

Record the installed version, platform/architecture and outcome in the
release verification notes. This post-publish check is acceptance — it does
not weaken the pre-publish build/inventory/ABI gates.

## Building from source

Developer docs live in [`packages/desktop/README.md`](../packages/desktop/README.md)
(run, architecture, view contract) — packaging is `npm run dist`
(electron-builder; macOS ad-hoc signed — not Developer ID, not notarized —
certificate auto-discovery disabled) and
`npm run dist:smoke` verifies the packed artifact. Build/release CI uses the
marked build-verify mode (inventory + strict codesign verification +
node-pty ABI, no GUI launch); a local
interactive run may also exercise the launch phase.
