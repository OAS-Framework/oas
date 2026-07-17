# Conventions — canonical files and generated views

OAS uses one canonical source for durable soul content and generated,
instance-local views for deployment composition.

## Operating documents

```text
soul/AGENTS.md                  # canonical role instructions
soul/CLAUDE.md -> AGENTS.md
instance/AGENTS.md              # generated regular file
instance/CLAUDE.md -> AGENTS.md
```

Never maintain an independent soul `CLAUDE.md`. Config-dependent capability,
work-mode, and workspace instructions belong only in generated instance
`AGENTS.md`; they must not be reconciled into the committed soul.

Generated blocks use `<!-- oas:<source> src=<file> -->` markers for
provenance. Edit the canonical soul, source file, or target binding, then spawn
a new instance. `oas doctor --soul <name>` previews the same final composition.

## Skills

The only OAS-managed runtime skill root is the instance:

```text
instance/.agents/skills/                    # canonical exact set
instance/.claude/skills -> ../.agents/skills
```

Spawn copies kernel + soul-private + active capability skills into real
instance-local directories there. Directory symlinks are not used because
harness recursive discovery may not descend through them. Packages retain
skills in their own artifact; activation selects them for materialization. Config-level `.agents/skills` is not an OAS capability source
or an ambient runtime discovery root.

Pi starts spawned sessions with ambient discovery disabled and the one
instance path explicit. Claude uses the instance-local project/config-home views and only
the redirected `user` setting source. `oas-getting-started` is the sole pre-workspace ambient bootstrap.

Duplicate skill directory names are errors unless config's `skill-overrides`
selects a source.

## Package locations

```text
<package>/capabilities/<name>/oas.json                 # the official marketplace (install source, not ambient)
<level>/.agents/capabilities/installed/<name>/oas.json # acquired (gitignored, restorable)
<level>/.agents/capabilities/owned/<name>/oas.json     # authored at this scope (source; committed where the scope is a repo)
<level>/oas-lock.json                                  # external source/integrity/trust
```

## Quick map

| Thing | Canonical location |
|---|---|
| Config | `<level>/oas-config.yaml` |
| Acquisition lock | `<level>/oas-lock.json` |
| Soul operating doc | `soul/AGENTS.md` |
| Soul Claude view | `soul/CLAUDE.md -> AGENTS.md` |
| Soul-private skills | `soul/skills/` |
| Instance operating doc | `instance/AGENTS.md` (generated) |
| Instance skill set | `instance/.agents/skills/` |
| Instance metadata | `instance/instance.json` |

Symlinks prevent compatibility paths from drifting. Generated regular files
separate canonical portable identity from scope-dependent runtime policy.
