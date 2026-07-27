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
`GET /api/models?runtime=pi|claude`. The server must not gate `POST /api/spawn`
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
fills with a modal-generation token so a late response cannot mutate a reopened
modal, and construct options with `createElement` plus `textContent` because
catalog ids are external data.

# Related concepts

- [Spawn endpoint root allowlist, empty-task semantics, and CLI-unavailable degradation](/architecture/spawn-endpoint.md)
- [Assign workspace data to DOM properties, never interpolate it into attributes](/lessons/dom-construction-not-innerhtml-attributes.md)
- [CLI degradation state must distinguish pending, compatible, and unavailable](/lessons/degradation-state-unknown-capable.md)
