---
type: Lesson
title: Digest the file bytes, not the decoded string — and keep the BOM
description: Hashing a UTF-8-decoded string silently digests U+FFFD replacements and drops the BOM, producing a content digest that nothing can reproduce from the file it claims to describe.
tags: [kernel, packages, integrity, config-templates, encoding]
timestamp: 2026-07-29
---

# The bug shape

```js
const content = readFileSync(file, "utf8");
contentIntegrity = `sha256-${createHash("sha256").update(content).digest("hex")}`;
```

This reads correct for every well-formed ASCII file, which is every fixture
anyone writes. It breaks in two ways that only appear on real payloads:

1. **Invalid UTF-8 is replaced, not rejected.** `readFileSync(..., "utf8")`
   substitutes U+FFFD for undecodable bytes. The digest then covers the
   *replacements*, so it can never be reproduced from the file's actual bytes.
2. **`TextDecoder`/`readFileSync` strip a leading BOM.** Even for perfectly
   valid UTF-8, the decoded string re-encodes to *fewer bytes* than the file
   holds.

Both matter here because a config template's `contentIntegrity` is what an
adopter compares against after writing the template into their own repo. A
digest that does not describe the bytes on disk is worse than no digest.

# The fix

```js
const TEMPLATE_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const bytes = readFileSync(file);                       // Buffer
try { content = TEMPLATE_DECODER.decode(bytes); }
catch { throw oasError("invalid-package-manifest", `... is not valid UTF-8`); }
contentIntegrity = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
```

- `fatal: true` — undecodable bytes are a **malformed package**, not something
  to repair. The format says UTF-8 text; anything else fails closed.
- `ignoreBOM: true` — counter-intuitive name: it means "do not *strip* the BOM",
  so the returned string re-encodes to the exact bytes the digest covers.
- The digest is over the **Buffer**, always.

# The test that actually catches it

Round-trip, not equality against a hand-computed constant:

```js
assert.equal(
  `sha256-${createHash("sha256").update(Buffer.from(result.content, "utf8")).digest("hex")}`,
  result.contentIntegrity,
  "content round-trips to the same bytes");
```

Use a fixture with a BOM, a multi-byte character, a NUL and a lone CR. An
ASCII fixture passes every broken variant of this code.

# Generalization

Whenever a value is both **hashed** and **handed back for reuse**, hash the
representation the consumer will write back. Decoding is lossy at the edges;
integrity is not allowed to be. Related: [pre-commit gate beats post-hoc rollback](/lessons/pre-commit-gate-beats-post-hoc-rollback.md).
