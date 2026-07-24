---
type: Decision
title: First public OAS Desktop release contract
description: OAS Desktop launches publicly in the synchronized v0.18.0 release with an explicit installer matrix, Desktop CLI API v1, observation-only no-CLI mode, installed-artifact parity gates, and split CLI/Desktop ownership.
status: accepted
tags: [desktop, release, distribution, cli, installers]
timestamp: 2026-07-24
---

# Context

PR #19 completed the source ownership cut: Desktop owns its backend and the old
web/TUI panels are retired. Publication remains blocked by the direct adjacent-
kernel bridge and absence of installer automation. Human direction is to make
Desktop fully public now, not preserve a hypothetical legacy-user sunset. The
operator confirmed that the removed panels had no other current users, but the
technical migration diagnostics remain part of a responsible breaking release.

At contract time the root and pi npm packages are 0.17.6, Desktop is a private
0.1.0 package, and the tag workflow publishes only npm. The repository has an
npm publication secret but no Apple or Windows signing/notarization credentials,
Actions variables, or release environments.

This contract implements the release gate in the [Desktop panel succession
decision](/decisions/desktop-panel-succession.md) and preserves the public CLI
boundary from the [standalone CLI decision](/decisions/standalone-cli.md).

# Release identity and ordering

The first public release is **`v0.18.0`**. One tag on one exact main commit
produces three version-identical products:

- `@oas-framework/oas@0.18.0` on npm;
- `@oas-framework/pi@0.18.0` on npm; and
- OAS Desktop 0.18.0 assets on GitHub Release `v0.18.0`.

There is no separate desktop tag or version line. Source manifests retain their
previous versions before tagging; release CI derives 0.18.0 from the tag for
root, pi, and the private desktop package, then records all manifest/lock bumps
through the protected-main bump PR.

Release CI checks out the immutable tag SHA, not mutable `main`. Permissible
ordering inside the one release is:

1. build, test, checksum, and attest every installer;
2. smoke packed npm and installed desktop artifacts outside the checkout;
3. publish root npm, then pi npm;
4. create the public GitHub Release with Desktop assets and notes; and
5. create the version-bump PR.

If npm succeeds but GitHub publication fails, publication resumes from the same
tag and built assets; the tag is not moved. Partial npm publication follows the
existing new-patch recovery rule. Artifact verification follows the
[release verification](/lessons/release-verification.md) and [cross-checkout
package smoke](/lessons/package-smoke-tests-cross-checkout-boundary.md) lessons.

# Installer matrix and trust posture

Version 0.18.0 publishes:

- macOS arm64: DMG and ZIP;
- macOS x64: DMG and ZIP;
- Linux x64: AppImage and DEB; and
- `SHA256SUMS.txt` plus GitHub build-provenance attestations.

Windows is not claimed while native OAS depends on tmux and POSIX filesystem
behavior. Linux arm64 is not claimed until a native node-pty build runner and
installed-artifact smoke pass exist.

Because signing credentials are absent, 0.18.0 is explicitly **unsigned and not
notarized**. Builds disable accidental certificate auto-discovery, and the
Release/download UI names the posture without implying platform trust.
Checksums and provenance attestations are mandatory. Missing credentials do not
block this human-directed first publication. Future signing maps distinct
Apple certificate/notarization and Windows certificate secrets into platform
jobs; Windows secrets are irrelevant until Windows itself is supported.

# Installed CLI discovery and Desktop API v1

A shipped Desktop app never imports checkout `lib/core.mjs`, accepts a source-
root override, or uses a selected workspace as executable authority.

Discovery order is:

1. a persisted user-selected absolute executable;
2. the test/development `OAS_DESKTOP_OAS_BIN` override;
3. the app process `PATH`;
4. npm global-prefix candidates; and
5. the user's login-shell `command -v oas`, with a timeout.

Every candidate is canonicalized to an absolute executable and accepted only
after this probe:

```json
{"schemaVersion":1,"name":"@oas-framework/oas","version":"0.18.0","desktopApi":1}
```

The command is `oas version --json`. Desktop 0.18 accepts `desktopApi: 1` and
semver `>=0.18.0 <0.19.0`; the explicit API epoch, not path adjacency, is
authoritative. Discovery re-runs on launch, app focus, explicit Retry, and
binary selection.

Desktop API v1 exposes only two OAS mutations:

1. `oas spawn <agent> --dir <workspace> --task-file <0600-temp> ... --json`,
   with only allowlisted purpose/repo/work/runtime/model arguments; and
2. `oas okf harvest --json`, with cwd fixed by the privileged backend to the
   resolved instance home.

The backend executes the discovered absolute binary with argv (`execFile`),
never a shell. JSON mode emits exactly one stdout object and no progress prose:
`{schemaVersion:1,ok:true,result:{...}}` on success; failures exit nonzero with
`{schemaVersion:1,ok:false,error:{code,message}}`. Spawn returns instance,
agent, home, work, branch, launched, warnings, and tmux data. Harvest returns
spawned versus skipped plus instance/window or reason. Retire, create,
configuration, and package operations are not Desktop v1 mutations.

# Observation without a CLI

Desktop bundles an app-owned read-only deployment reader, not a hidden kernel.
Without a compatible CLI, an existing deployment still supports roster,
hierarchy, brain, markdown/task/state/git reads, and attach/write to already-
running tmux sessions. Workspace recents and picking remain app-local.

Spawn and Harvest are disabled behind one affordance that shows detected
path/version and required range, with **Choose oas…**, **Retry**, a setup link,
and the copyable command `npm install -g @oas-framework/oas@0.18.0`. Desktop
does not silently run a privileged global npm installation. Missing tmux has a
separate diagnostic. With no deployment, onboarding shows workspace selection
and OAS installation guidance rather than a fabricated repo-root workspace.

# Consumer-parity acceptance

Acceptance uses packaged artifacts installed outside the checkout and a CLI
installed from packed or published npm. A framework workspace and an unrelated
multi-repository team workspace both follow the same path as third-party
consumers:

- launch as a normal GUI with minimal inherited `PATH`;
- discover the same global CLI;
- resolve the correct team and agents roots;
- render roster, brain, and markdown;
- attach the intended tmux target;
- spawn into the selected workspace with correct soul/capability/team
  resolution; and
- harvest from the selected instance home.

Evidence must show no source-root environment, import, fallback, or privileged
local exception. A second run with the CLI hidden or incompatible must preserve
reads/terminal interaction while disabling mutations. Equivalent installed-
artifact smoke runs on every published OS/architecture.

# Migration notes and dormant surfaces

The 0.18.0 notes name `oas.web`, `oas pane`, and
`@oas-framework/oas/control-pane` as removed; provide exact doctor-guided
config, lock, and artifact cleanup; link the Desktop replacement; state the
supported matrix, tmux requirement, unsigned posture, CLI range, and no-CLI
behavior; and explain why there was no separate notice release. Diagnostics
remain required even though no other legacy user is expected.

Desktop Diff and Jira views, harness entries, backend routes, subprocess/helper
code, tests, styles, imports, and release claims are removed before packaging.
The guarded file endpoint remains for Markdown. This does not remove the
framework's independent `oas.jira` capability. An artifact-inventory test proves
that dormant modules/routes are absent from the app bundle.

# Ownership

**cli-dev owns** the version probe, Desktop API/range contract, stdout-clean
spawn JSON and stable errors, harvest JSON dispatch/contract, retired-oas.web
diagnostics, exact-tag root/pi npm publication, bump PR, and CLI release notes
and tests.

**oas-desktop-engineer owns** electron-builder/version injection, macOS/Linux
builds and native node-pty rebuilds, checksums/attestations and GitHub assets,
CLI discovery and absolute execution, the no-CLI reader and affordance,
spawn/harvest UI integration, removal of repo-root/core bridges, dormant
Diff/Jira pruning, installed-installer smoke, consumer-parity evidence, and
Desktop release notes.

The seam is jointly gated but not jointly owned: cli-dev supplies fixed JSON
contracts and fixtures; Desktop consumes them in end-to-end tests. One combined
exact-tag rehearsal must pass before `v0.18.0` is cut.
