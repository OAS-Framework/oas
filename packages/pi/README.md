# @oas-framework/pi

Pi runtime bridge for [OAS](https://github.com/OAS-Framework/oas).

The runtime-neutral kernel and universal `oas` CLI live in
`@oas-framework/oas`. Publishes in lockstep with the kernel (same version
from the same release tag). This bridge registers no operational tools. It only:

- exposes `oas-getting-started` before an OAS workspace exists (the
  acquisition funnel);
- contributes the instance-local `.agents/skills` set inside a spawned
  instance;
- journals compaction summaries and sends resume nudges when the active
  knowledge capability created `STATE.md`/`log.md` — the OKF session
  protocol enforced at runtime.

Skill resolution itself is owned by the kernel: spawn materializes the exact
kernel + soul + active-capability set into each instance's `.agents/skills`
and launches pi with that directory as an explicit skill path. Ambient
skills (user-level, packages, work tree) coexist with the OAS-composed set.

```bash
npm install -g @oas-framework/oas
pi install npm:@oas-framework/pi
```

OAS
publishes both packages from the same version tag. Reload pi after an adapter
install or upgrade.

All lifecycle/config/package operations use the shell-visible CLI: `oas
status`, `oas spawn`, `oas doctor`, `oas install`, `oas trust`, `oas use`, and
`oas retire`.
