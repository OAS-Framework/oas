# oas-dev

Official OAS-project development policy package. It combines:

- the independently targetable `oas.review@1.1.7` capability, including its ephemeral reviewer and code/security review skills; and
- a reference `default` workspace profile for developing OAS itself, with framework-author, developer, and official-package-maintainer agent families.

The distribution package is `oas.dev@1.0.0`; the inner capability intentionally keeps its separate `oas.review@1.1.7` identity and version.

## Not part of default init

`oas.dev` is for contributors and maintainers working on the OAS project. It is **not** part of OAS's default initialization profile and must never be applied implicitly.

The profile recommends OAS knowledge and messaging integrations plus authoring/review policy. Its dependency selectors remain publication placeholders, so this package cannot be acquired, probed, or released until those selectors are pinned to immutable official releases. See [`SCHEMA-STATUS.md`](SCHEMA-STATUS.md).

## Adopt the development profile

After publication and immutable dependency pins exist, preview and snapshot the profile at an OAS development workspace root:

```bash
oas init --package oas.dev --config default --dir /path/to/oas-workspace
```

Profile adoption is explicit and refuses to overwrite an existing config. The resulting `oas-config.yaml` is an ordinary local snapshot: closer child-repository configs can override its layer providers and authoring/review targets.

The profile defines:

- `framework-authors`: `oas.authoring`;
- `developers`: `oas.review`;
- `package-maintainers`: both `oas.authoring` and `oas.review`;
- knowledge through `oas.okf`, messaging through `oas.aweb`, and tasks explicitly `none`.

## Acquire or activate review independently

The inner review capability remains independently targetable after its provider package is acquired:

```bash
oas install oas.dev --dir /path/to/scope
oas use oas.review --type developers --dir /path/to/scope
oas doctor /path/to/scope --soul <developer-soul>
```

The capability has no commands or lifecycle hooks, so it does not require executable trust. Its reviewer uses the deployment's configured messaging layer to deliver verdicts.

## Development

```bash
npm test
```

The package-local gates validate both manifests, resource containment, the reviewer contract, the exact profile target matrix, and a child-repository override fixture. The released OAS 0.19.0 consumer probe and immutable dependency pins remain external release gates.
