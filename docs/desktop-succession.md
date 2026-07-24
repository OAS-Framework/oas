# BREAKING: desktop succession — `oas.web`, `oas pane`, and the control-pane library are retired

**The next release of `@oas-framework/oas` containing this change is a
BREAKING release.** Three previously shipped surfaces were removed in favor of
the OAS Desktop app (`packages/desktop/` in the framework repo):

| Removed surface | Replacement |
|---|---|
| `oas.web` marketplace capability (`oas web start`, browser panel) | OAS Desktop app — the same zero-dependency loopback server is bundled at `packages/desktop/server/` and spawned by the app |
| `oas pane` CLI command and the Control Pane TUI | OAS Desktop app (Active overview / instance roster) |
| `@oas-framework/oas/control-pane` package export (`lib/control-pane/model.mjs`) | The roster model moved into `packages/desktop/server/model.mjs`; it is no longer a public kernel export |

## Migrating a deployment that used `oas.web`

1. Remove the `oas.web` entry from `capabilities.additive` in every
   `oas-config.yaml` in your config chain.
2. Remove the `oas.web` entry from `oas-lock.json` at the same scope(s), and
   delete any stale installed copy under `.agents/capabilities/installed/`.
3. Use the OAS Desktop app instead: `cd packages/desktop && npm install &&
   npm run rebuild && npm start` (see `packages/desktop/README.md`).

The CLI diagnoses stale references instead of failing opaquely:

- `oas doctor` warns when an `oas-lock.json` still pins `oas.web`, with the
  fix spelled out.
- Bare `oas install` reports the lock entry as `RETIRED` (with guidance)
  rather than a restore failure.
- `oas install oas.web` and a config activation of `oas.web` fail with a
  message naming the successor and the exact cleanup steps.

## Migrating `oas pane` usage

`oas pane` now exits with a pointer to the desktop app. Scripts or docs
invoking it should launch OAS Desktop instead. The `--theme` themes (dark,
solarized) exist in the app's theme system.

## Consumers of the `./control-pane` export

`import ... from "@oas-framework/oas/control-pane"` no longer resolves. The
model's pure helpers (`readMarkdownSection`, `parseTmuxWindows`,
`parseGitStatus`, `parseGitDiffStat`, `buildConstellation`, `relativeAge`)
live in `packages/desktop/server/model.mjs`, which is private to the desktop
app. If you depended on this export, vendor the helpers or open an issue —
no known external consumer existed at removal time.

## Release gating (maintainers)

Downstream installers/packaging for the desktop app must exist **before** the
next release ships; this migration note travels with the release notes and
the release must be flagged **BREAKING** (major or clearly-marked minor per
the project's pre-1.0 conventions).
