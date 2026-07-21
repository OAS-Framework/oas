---
name: retrofit-aweb-identity
description: >-
  Use when a live OAS instance was spawned without an aweb identity, when aweb
  setup or the spawn hook was skipped, when an instance has a broken `undefined`
  aw workspace, or when aweb awakenings require replaying the oas-aweb spawn
  hook and updating instance metadata.
---

# Retrofitting aweb identity onto a live instance

Use the capability spawn hook, not plain `aw init`, when an already-spawned
OAS instance needs aweb identity added after the fact. The hook runs the
invite/join flow expected by the OAS aweb integration.

## Procedure

From the target instance home, replay the hook with the kernel env contract:

```bash
OAS_EVENT=spawn OAS_INSTANCE=<instance-name> OAS_HOME="$PWD" \
OAS_WORKSPACE=<workspace-root> OAS_TEAM_SCOPE=<workspace-root> \
OAS_TEAM_ID='<team>:<namespace>' \
node <oas-pkg>/capabilities/oas-aweb/bin/oas-aweb.mjs spawn
```

Then persist the identity metadata in the target instance's `instance.json`:

```json
{
  "capabilityMeta": {
    "oas.aweb": {
      "team": "<team>:<namespace>",
      "alias": "<instance-name>"
    }
  }
}
```

Restart the pi session or run `/reload` before expecting aweb channel
awakenings to fire.

## Gotchas

- Running the hook without the env contract can still appear to succeed while
  minting an identity with alias `undefined`. Clean that with
  `aw workspace delete undefined` from the instance home, remove `.aw/`, then
  rerun the hook with the env set.
- Plain `aw init` is the wrong recovery path when `.aw/` is absent: it asks
  for hosted onboarding (`--username`) instead of doing the OAS invite/join
  flow.
- If `capabilityMeta["oas.aweb"]` is not written to `instance.json`, the
  retire hook cannot self-delete the identity cleanly.
