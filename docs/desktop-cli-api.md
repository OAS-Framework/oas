# Desktop CLI API v1

The contract between the OAS Desktop app and the `oas` CLI. Desktop never
imports kernel code; it shells out (via `execFile`, argv, absolute binary — no
shell) to a discovered `oas` and speaks this JSON protocol. **API version, not
source adjacency, is authoritative.**

## Probe

```
oas version --json
```

prints exactly one JSON object on stdout:

```json
{"schemaVersion":1,"name":"@oas-framework/oas","version":"<installed version>","desktopApi":1}
```

`version` is the installed package's exact semver (e.g. `0.18.0`).
Desktop 0.18 accepts `desktopApi === 1` and semver `>=0.18.0 <0.19.0`.

## Envelope

Every other `--json` command emits **exactly one JSON object on stdout** and
no progress prose (progress goes to stderr):

- success (exit 0): `{"schemaVersion":1,"ok":true,"result":{...}}`
- failure (nonzero exit): `{"schemaVersion":1,"ok":false,"error":{"code":"...","message":"..."}}`

## Mutations exposed to Desktop v1

Only two:

### `oas spawn <agent> … --json`

`result` fields (always present):

| field      | type            | meaning                                    |
| ---------- | --------------- | ------------------------------------------ |
| `instance` | string          | new instance name                          |
| `agent`    | string          | soul/agent name                            |
| `home`     | string          | absolute instance home path                |
| `work`     | string          | work mode (worktree/checkout/attached/workspace) |
| `branch`   | string \| null  | work branch when applicable                |
| `launched` | boolean         | whether a tmux window was started          |
| `warnings` | string[]        | non-fatal warnings (always an array)       |
| `tmux`     | {session,window} \| null | tmux target                       |

Additional informative fields: `repo`, `runtime`, `model`, `parent`,
`spawnOrigin`, `attach`.

Stable error codes: `E_USAGE`, `E_NO_DEPLOYMENT`, `E_UNKNOWN_AGENT`,
`E_AMBIGUOUS_SOUL`, `E_PARENT_NOT_FOUND`, `E_BAD_ARGS`, `E_SPAWN_FAILED`.

Dispatch-level failures (any `--json` command): `E_UNKNOWN_COMMAND` (no
kernel subcommand or capability namespace matches, or unknown capability
subcommand), `E_CAPABILITY_INACTIVE`, `E_CAPABILITY_BLOCKED` (untrusted),
`E_CAPABILITY_BROKEN`, `E_DUPLICATE_NAMESPACE`, `E_CONFIG_BROKEN` — all still
exactly one stdout envelope with a nonzero exit.

### `oas okf harvest --json`

Run with cwd fixed to the resolved instance home. `result` is one of:

```json
{"harvest":"spawned","instance":"memory-harvest-<slug>","window":"memory-harvest-<slug>"}
{"harvest":"skipped","reason":"no pending notes"}
```

Failure: `{"schemaVersion":1,"ok":false,"error":{"code":"E_HARVEST_FAILED","message":"..."}}`
with exit 1. Skip reasons are human-readable strings (loop guard, no notes,
no root, no identity, harvester already running, workspace-mode soul not in a
git repo).

Contract tests / canonical fixtures: `test/cli-json-contract.test.mjs`.
