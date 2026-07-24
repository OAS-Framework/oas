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
| macOS arm64 (Apple Silicon) | DMG + ZIP | unsigned — see below |
| macOS x64 (Intel) | DMG + ZIP | unsigned — see below |
| Linux x64 | AppImage + DEB | requires `tmux` |

**Windows and Linux arm64 are not supported in 0.18.x.**

Verify downloads against the release's `SHA256SUMS.txt`. GitHub
build-provenance attestations are published for every asset
(`gh attestation verify <file> --repo OAS-Framework/oas`).

### macOS: unsigned build

The 0.18.1 installers are **unsigned and not notarized** (no signing
credentials exist yet — nothing about this release claims otherwise).
Gatekeeper will block the first launch:

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
npm install -g @oas-framework/oas@0.18.1
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

0.18.1 removes the legacy `oas.web` browser panel, `oas pane`, and the
`@oas-framework/oas/control-pane` export. The Desktop app replaces all
three. Migration:

1. Update the CLI everywhere: `npm install -g @oas-framework/oas@0.18.1`.
2. Run `oas doctor` at each workspace scope and follow its guidance to
   remove stale `oas.web` config entries, locks, and installed artifacts.
3. Install the Desktop app (above) and open your workspace.

The full breaking-change list is in the
[v0.18.1 release notes](release-notes/v0.18.1.md).

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
| macOS "app is damaged / can't be opened" | Unsigned build + quarantine. Right-click → Open, or clear the quarantine attribute (above). |
| Roster empty | The opened directory isn't an OAS workspace (needs `agents/` or `local-agents/`, or a team scope). Use the workspace switcher → Add workspace to select the right root. |

For bugs, attach the terminal output of the app (`OAS Desktop` prints
server and CLI-discovery logs to stdout) and your platform/arch.

## Building from source

Developer docs live in [`packages/desktop/README.md`](../packages/desktop/README.md)
(run, architecture, view contract) — packaging is `npm run dist`
(electron-builder; unsigned, certificate auto-discovery disabled) and
`npm run dist:smoke` verifies the packed artifact (inventory, node-pty
under the packaged Electron ABI, headless app launch).
