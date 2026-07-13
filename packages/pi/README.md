# @oas-framework/pi

Minimal pi adapter for [OAS](https://github.com/OAS-Framework/oas).

The runtime-neutral kernel and universal `oas` CLI live in
`@oas-framework/oas`. This adapter registers no operational tools. It only:

- exposes `oas-getting-started` before an OAS workspace exists;
- points spawned sessions at their exact instance-local `.agents/skills` set;
- journals compaction summaries and sends resume nudges when the active
  knowledge capability created `STATE.md`/`log.md`.

The kernel launches pi with `--no-skills --skill <instance>/.agents/skills`,
so user, project, settings, ancestor, and pi-package skill discovery cannot
pollute one soul's selected runtime surface.

```bash
npm install -g @oas-framework/oas
pi install npm:@oas-framework/pi
```

Install matching versions and upgrade both packages together. Exact isolation
needs the new kernel launch flags and this adapter's instance-only discovery.
An older adapter still contributes workspace and package skill roots. OAS
publishes both packages from the same version tag. Reload pi after an adapter
install or upgrade.

All lifecycle/config/package operations use the shell-visible CLI: `oas
status`, `oas spawn`, `oas doctor`, `oas install`, `oas trust`, `oas use`, and
`oas retire`.
