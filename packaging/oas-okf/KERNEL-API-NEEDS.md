# oas-okf package runtime API needs

Status: staging inventory for `oas.okf` 1.4.0. The current implementation dynamically locates the OAS install with `oas root` and imports private `lib/core.mjs`. This is forbidden for an independently released package. The import remains only as `TODO(package-runtime-boundary)` until the engine supplies a documented, versioned replacement.

All calls below occur only in the agent-initiated `oas okf harvest` command, after pending notes and source-instance metadata have been validated. The `soul-scaffold` and `spawn` lifecycle hooks do not import the kernel.

## 1. Locate an agent definition

Current call:

```js
core.findAgent(root, "memory-harvest")
```

Used once to find the service agent and again after an upsert. Required behavior:

- `root` is the canonical deployment agents root derived from `OAS_ROOT` or the source instance home.
- Return `undefined` when no matching persistent/local soul exists.
- Otherwise return the complete agent object accepted by the spawn API, including its home metadata (`_dir`) and defaults such as repo/work/runtime/model.
- Preserve current lookup across persistent agents and canonical/legacy local-agent locations.

The returned object is copied with `kind: "capability"` before spawn so the harvester remains ephemeral even though its on-disk service soul is local.

## 2. Ensure the local service-agent definition

Current compatibility-selected call:

```js
const upsert = core.upsertLocalAgent || core.upsertTmpAgent;
upsert(root, {
  name: "memory-harvest",
  instructions: readFileSync(<package>/agents/memory-harvest.md, "utf8")
});
```

Required behavior:

- Create or update an uncommitted local soul named `memory-harvest` beneath the deployment represented by `root`.
- Use the package-owned Markdown as canonical agent instructions.
- Return an agent object (the current code deliberately calls `findAgent` again rather than relying on this return).
- Run normal local-soul validation/scaffolding and reject collision with a persistent agent.
- `upsertTmpAgent` is needed only as a compatibility alias for older kernels; the public boundary can expose one stable operation.

## 3. Resolve active OKF settings

Current call:

```js
core.resolveOasConfig(context).layers?.knowledge?.settings?.["harvest-model"]
```

Required behavior:

- `context` is the source instance's repository/config context from `OAS_CONTEXT` or `instance.json.repo`.
- Resolve the same scoped config, target precedence, and exclusive knowledge-layer selection as normal OAS execution.
- Return enough structured data to read the selected knowledge capability's effective `settings["harvest-model"]`.
- Throw on invalid/ambiguous config; the command catches that failure and falls back to `github-copilot/gpt-5.5`.

Hook-provided `OAS_SETTINGS["harvest-model"]` remains higher priority and avoids this call when present.

## 4. Spawn the ephemeral harvester

Current call shape:

```js
core.spawnInstance(root, agentDef, options)
```

`agentDef` must be the object returned by agent lookup (not an agent-name string), copied with `kind: "capability"`. Default launch behavior is required: scaffold the instance, run capability hooks/composition, record metadata, and launch its runtime session. Errors must throw. Success must return at least:

```js
{ instance: <final instance name>, tmux: { window: <window name or undefined> } }
```

Shared fields across all modes:

- `instance`: deterministic `memory-harvest-${slug}`, where slug derives from the source instance.
- `model`: effective `harvest-model` setting or the OKF default.
- `task`: complete, package-authored harvesting instructions with absolute source-note and destination paths.

### 4a. Local-soul source: attached direct-edit harvest

```js
{
  instance: harvName,
  parent: sourceInstance,
  repo: context,
  work: "attached",
  workDir: realpath(<source-home>/work),
  model: harvestModel,
  task: <direct-edit/no-commit instructions>
}
```

Expectations: attach to the owner's work tree, record the harvester as the source instance's child, but direct the task to edit the uncommitted local soul in place and never commit the owner's work tree.

### 4b. Workspace-mode source: dedicated soul-repo worktree

```js
{
  instance: harvName,
  parent: sourceInstance,
  repo: soulRepo,
  work: "worktree",
  branch: `memory-harvest/${slug}`,
  model: harvestModel,
  task: <commit/push/PR instructions>
}
```

Expectations: create a worktree and named branch in the repository that owns the soul, then launch the harvester there. The task owns commit/push/PR delivery.

### 4c. Repo-resident source: attached same-branch harvest

```js
{
  instance: harvName,
  parent: sourceInstance,
  repo: context,
  work: "attached",
  workDir: realpath(<source-home>/work),
  model: harvestModel,
  task: <same-branch commit instructions>
}
```

Expectations: attach as a child to the source instance's worktree so knowledge/skill promotions commit on that same branch.

## 5. Current private-boundary bootstrap to remove

Before using the APIs, the package currently:

1. tries a repository-relative `../../..` candidate for `lib/core.mjs`;
2. otherwise executes `oas root` with a 15-second timeout;
3. dynamically imports `<root>/lib/core.mjs` via a file URL.

The standalone package must remove both private-file path assumptions. The supported runtime boundary must provide the four services above through either a versioned module export or structured CLI API and must have a compatibility floor tied to the release that ships it.

## Non-kernel contracts the command already supplies itself

No public kernel API is requested for note enumeration, debounce-home checks, source `instance.json` parsing, soul/repository path discovery, git-root discovery, task text, or JSON result envelopes. Those remain package-owned unless the runtime boundary intentionally replaces them with a higher-level harvest-spawn service.
