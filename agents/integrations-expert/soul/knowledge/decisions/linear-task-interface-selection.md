---
type: Decision
title: Prefer an integration-owned Linear GraphQL wrapper
description: Linear task integrations should use a narrow JSON-first GraphQL wrapper rather than depend on the limited official CLI or an unstable third-party CLI contract.
tags:
  - integrations
  - linear
  - tasks
timestamp: 2026-07-10
---

# Prefer an integration-owned Linear GraphQL wrapper

For a contributed OAS Linear tasks integration, use Linear's official GraphQL
API through an integration-owned `oas linear` command wrapper. Node's built-in
`fetch` avoids an extra runtime dependency, while the wrapper can expose only
the task-safe operations agents need and return stable JSON.

The official `@linear/cli` is not suitable as the task layer's command surface:
its published interface only creates an issue or checks out a branch, so it
cannot read queues/issues, change workflow state, manage identity labels, or
post handoff comments. Third-party Linear CLIs offer broader but mutually
incompatible contracts. The official SDK is supported but large and unnecessary
for a small set of GraphQL operations.

Personal script authentication is a human-created Linear API key passed as the
raw `Authorization` header. Keep it in `LINEAR_API_KEY`, never tracker settings
in a checked-in `oas-config.yaml`. Because OAS `requires` describes commands,
not environment variables, use a non-blocking spawn-hook warning plus an
actionable `oas linear auth` failure to surface missing authentication.

# Citations

1. [Linear GraphQL API and authentication](https://linear.app/developers/graphql)
2. [`@linear/cli` package usage](https://www.npmjs.com/package/@linear/cli)
3. [Linear SDK repository](https://github.com/linear/linear/tree/master/packages/sdk)
