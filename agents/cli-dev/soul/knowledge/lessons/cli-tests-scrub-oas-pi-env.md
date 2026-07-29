---
type: Lesson
title: CLI tests that spawn oas must scrub OAS/PI env and pin HOME
description: CLI tests spawned inside an OAS instance inherit instance and laptop-level context unless their child environment removes OAS/PI variables and pins HOME to a fixture directory.
tags: [testing, oas-cli, hermeticity, capability-materialization]
timestamp: 2026-07-29
---

# The trap

CLI tests that spawn `bin/oas.mjs` with `{ ...process.env }` are not hermetic
when the suite itself runs inside an OAS instance. Two independent ambient
contexts can redirect a fixture-backed CLI command into the developer's real
deployment:

1. `bin/oas.mjs` dispatch reads `process.env.PI_AGENT_HOME || process.env.OAS_HOME`; when that directory has an `instance.json`, `capabilityCommand()` takes `meta.repo` as the command context and discards the intended fixture scope.
2. `lockLevels()` walks ancestors to `/` and unions every `configChain()` level, including `homedir()`, so a developer's `~/oas-config.yaml` or `~/oas-lock.json` can affect a fixture in a temp directory.

The exposing symptom was a dispatch test failing with
`oas: /Users/<me>/oas-lock.json: unsupported transitional package-root lockfileVersion 2`,
a path no fixture could reach. Setting `HOME` alone did not fix it because the
`OAS_HOME` / `PI_AGENT_HOME` leak is separate.

# Fix shape

Build CLI child environments by exclusion, then set an explicit fixture home:

```js
const HERMETIC_HOME = mkdtempSync(join(tmpdir(), "<suite>-home-"));
function hermeticEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(OAS|PI)_/.test(k)) env[k] = v;
  env.HOME = HERMETIC_HOME;
  env.OAS_HOME_DIR = join(HERMETIC_HOME, ".oas");
  return env;
}
```

Apply the helper at the shared `cli()` wrapper level so all `spawnSync()` calls
get the same scrub. Per-call `env` overrides can still merge on top when a test
deliberately supplies a hostile `PATH` or fixture `HOME`.

# Why this matters

A leaking suite can pass for the wrong reason. In the observed case, two
`test/cli-lifecycle.test.mjs` cases expected a failure and got one while reading
the wrong deployment entirely. Treat any expected-nonzero CLI assertion as
suspect until the helper proves the command resolved the intended fixture.

`test/desktop-deployment.test.mjs` is a known exception shape: it deliberately
probes the live machine deployment. A machine with a laptop-level superseded
transitional-v2 lock can still fail its `reader parity` case if live-deployment
probes escape the existing guard. See the revised-v2 discriminator reference for
the transitional-v2 error this can surface:
[revised-v2 lock discriminator](/references/revised-v2-lock-discriminator-cli-coverage.md).
