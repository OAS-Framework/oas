---
type: Lesson
title: Model selection UI must stay advisory
description: The spawn modal's model field must remain free text with an advisory datalist because OAS model preferences can be comma-separated or unknown to the catalog, and /api/spawn must not validate membership.
tags: [desktop, spawn, models, renderer]
timestamp: 2026-07-27
---

# Keep model selection advisory

`oas spawn --model` accepts comma-separated preference lists such as
`provider/id[:thinking],fallback`, resolved by `resolveModelPreference` in
`lib/core.mjs`. A hard `<select>` in the desktop Spawn modal would break that
contract and would also reject models that are valid for the runtime but missed by
the local catalog probe.

The Spawn modal model field therefore stays a free-text `.fmodel` input. The
catalog is only an advisory `<datalist id="spawn-model-options">` populated from
`POST /api/models` with body `{ runtime: "pi" | "claude" }`. The route is a POST
— never a GET — because a cache miss executes a child process (pi, possibly a
login shell) and must sit behind the server's POST-only CSRF Origin guard: a GET
on the fixed loopback port is reachable by hostile pages via no-cors requests
and can fan out unbounded child processes (review 9b1e3ff blocker). All
concurrent cache misses must coalesce behind ONE in-flight catalog promise so
request fan-in never multiplies probes. The server must not gate
`POST /api/spawn`
on catalog membership; catalog failures resolve to an empty list so a missing or
unavailable model-listing command does not break spawning.

# Runtime catalog shapes

For the `pi` runtime, `/api/models` shells out to `pi --list-models`, parses the
reported `provider/model` ids, and uses the same login-shell PATH fallback shape
as the CLI probe because GUI-launched Electron may not inherit the user's login
PATH. The result is cached briefly.

For the `claude` runtime, the advisory list combines Claude CLI aliases
(`opus`, `sonnet`, `haiku`, `sonnet[1m]`) with Anthropic entries discovered from
the Pi catalog after stripping the `anthropic/` provider prefix. Claude accepts
bare `claude-*` names, not Pi-style `anthropic/claude-*` ids; users typing
provider-prefixed ids into a Claude spawn are likely to see launch-time rejection.

# Renderer guardrails

Rebuild datalist options when the runtime selector changes. Guard asynchronous
fills with a PER-REQUEST monotonic generation token — a per-modal token is too
coarse: runtime flips inside one open modal race each other, and a slow earlier
response must never overwrite a later runtime's list (review bcf8255
important). Only the latest request may paint; also drop responses landing
after the modal closes or is replaced. Construct options with `createElement`
plus `textContent` because
catalog ids are external data.

# Related concepts

- [Spawn endpoint root allowlist, empty-task semantics, and CLI-unavailable degradation](/architecture/spawn-endpoint.md)
- [Assign workspace data to DOM properties, never interpolate it into attributes](/lessons/dom-construction-not-innerhtml-attributes.md)
- [CLI degradation state must distinguish pending, compatible, and unavailable](/lessons/degradation-state-unknown-capable.md)
