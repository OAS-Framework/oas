---
name: tasks-integration
description: >-
  Building a tasks-layer OAS integration (Jira, GitHub Issues, Linear, plain
  TODO files) — the layer with no shipped default. Use when integrating a
  task tracker: what the skills must teach, CLI-wrapping patterns, and the
  boundary with messaging. Triggers: "Jira integration", "task tracking for
  agents", "tasks layer", "GitHub issues integration".
---

# Tasks-layer integrations

The tasks layer has **no shipped default** — every deployment binds its own
tracker. Load integration-craft first; this adds the layer specifics.

**The tracker choice is a deployment decision, not a framework rule.** LFX
chose Jira over aweb's task features (one source of truth: Jira records,
aweb only messages) — but that rationale is LFX's, not OAS's. A deployment
that prefers aweb can bind `tasks: <aweb-tasks-integration>` and build an
integration teaching `aw task`/`work`/`lock`/`roles`; the bundled oas-aweb
integration is deliberately messaging-only, so tasks-on-aweb is a separate
integration. Never present the tasks≠messaging boundary as "tasks must not
be aweb" — the boundary is *whichever framework the tasks layer resolves to
owns task state*, and the messaging layer stays out of it.

## What the skills must teach

Task skills are conventions-heavy. Cover, concretely, for YOUR tracker:

1. **The hierarchy** as the deployment uses it (e.g. Jira: epic → story →
   task; agents' work usually hangs off a named epic/board).
2. **Identity conventions** — how an agent marks work as its own (e.g. an
   `agent-<alias>` label; assignee often stays human for accountability).
3. **State discipline** — statuses agents may set, statuses reserved for
   humans (e.g. agents move to "In Review", never "Done").
4. **The exact CLI incantations** — real, tested commands with flags
   (`acli jira workitem create --type Task --parent LFXV2-42 ...`), not
   pseudo-code. Include auth setup and how to detect being unauthenticated.
5. **The project/document support matrix** — when the tracker has projects,
   overviews/documents, issues, sub-issues, comments, or relations, document
   which operations are command-supported, human/UI-only, and future/not
   supported. Include recipes for common supported relationships (such as
   listing project issues and creating an issue or sub-issue in a project),
   state where durable information belongs (project docs explain work, issues
   execute it, comments record events, messaging carries conversation), and
   tell agents to escalate unavailable operations rather than invent API calls
   or guessed flags.
6. **The boundary**: tasks ≠ messaging. Status lives in the resolved tasks
   framework; conversation lives in the messaging layer — even when both
   layers happen to be the same product (e.g. aweb for messaging AND tasks:
   two integrations, two injections, one boundary). State it in the
   injection.

## Reference shape (LFX's hand-rolled Jira, the worked example)

Skills at the workspace level teach epic-roster conventions + acli commands;
injection points agents at them; declared as:

```yaml
groups:
  delivery-agents: [developer, reviewer]
capabilities:
  example.jira:
    groups:
      delivery-agents:
        enabled: true
        settings: {site: example.atlassian.net, project: PROJ}
```

No hooks needed — trackers rarely need per-instance lifecycle state. If yours
does (e.g. auto-creating a tracker item per instance), follow the hooks
contract in messaging-integration; use a namespaced capability manifest and
keep soul/group targets in config.

## requires

Declare the tracker CLI (`acli`, `gh`, `linear`...). Auth is per-human and
interactive — hooks must NOT attempt login; skills should teach agents to
detect auth failure and escalate to the human.

## Testing extras (beyond integration-craft's four)

- Run each documented CLI command against the real tracker once (sandbox
  project if available) — task skills rot fastest when commands are guessed.
- For project/document support matrices, verify that each command-supported
  relationship recipe works and each UI-only or unsupported operation tells
  the agent to escalate rather than guess.
- Verify the failure mode: with the CLI unauthenticated, do your skill's
  instructions lead the agent to escalate rather than flail?
