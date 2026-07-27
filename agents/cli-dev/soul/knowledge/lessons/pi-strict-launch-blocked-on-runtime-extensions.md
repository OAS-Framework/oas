---
type: Lesson
title: Pi strict launch is blocked until runtime extensions are capability resources
description: Pi strict launch cannot enable --no-extensions yet because oas-aweb only supplies Claude launch args and Pi messaging currently depends on the user's global pi extension.
tags: [pi, runtime, capabilities, aweb, strict-curriculum, launch]
timestamp: 2026-07-27
---

# Lesson

The verified Pi strict launch is:

```bash
pi --no-skills --skill <instance-home>/.agents/skills --no-extensions \
   -e <each selected extension> --no-context-files --no-prompt-templates \
   --append-system-prompt <instance-home>/AGENTS.md --approve --name <instance> @TASK.md
```

The `--no-extensions` flag is not optional for isolation; see [Pi strict
launch needs --no-extensions](/lessons/pi-strict-launch-requires-no-extensions.md).

# Blocker

Enabling this launch line before runtime extensions are declared by capabilities
would silently remove messaging from Pi instances. `--no-extensions` disables the
**aweb Pi extension**, which is what wakes a Pi session on incoming mail.

The `oas-aweb` capability currently contributes a launch flag only for Claude:

```js
// capabilities/oas-aweb/bin/oas-aweb.mjs
if ((process.env.OAS_RUNTIME || "") === "claude") {
  …claude plugin install aweb-channel@awebai-marketplace…
  launch = { claude: "--dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace" };
}
```

There is no Pi branch. Pi instances receive the channel from the user's global Pi
settings (`~/.pi/agent/settings.json` → `npm:@awebai/pi`), which is exactly the
ambient state strict composition is meant to remove.

# Required first step

Add a declared runtime plugin/extension resource class before switching Pi
instances to `--no-extensions`: a capability declares its extension as a locked,
trusted, integrity-contained resource; the kernel materializes it, records
provenance in `instance.json`, and emits `-e <path>` for Pi or `--plugin-dir
<path>` for Claude.

The existing spawn-hook `launch` map is the seam that already works for runtime
arguments, but hook-contributed args carry no provenance. The resource class is
the correct home for provenance and fail-closed materialization.

Open question for the founder: the aweb Pi extension is executable code shipped
as an npm package, not Markdown. The vendoring decision for the aweb skills does
not automatically decide where the locked extension copy comes from.

Until then, the Pi launch line keeps ambient extension discovery, with the reason
recorded at the call site rather than hidden as an omission.
