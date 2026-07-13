---
type: Reference
title: OKF v0.1 spec
description: Google Cloud's Open Knowledge Format — the markdown+frontmatter knowledge bundle spec OAS uses for soul memory.
resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
tags: [okf, standard]
timestamp: 2026-07-08
---

OKF v0.1 (draft), from `GoogleCloudPlatform/knowledge-catalog`. Bundle =
directory of markdown concepts; only `type` frontmatter required; reserved
`index.md`/`log.md`; links = untyped directed edges; permissive consumption
(unknown types/broken links never reject a bundle).

Key spec positions OAS relies on: progressive disclosure via index.md;
`log.md` date-grouped newest-first; `okf_version: "0.1"` only in bundle-root
index frontmatter. Type values are unregistered; the spec's non-normative
examples include `Playbook` and `Reference` (with a full Playbook sample) —
the rest are catalog-flavored (`BigQuery Table`, `Metric`, …).

The repo also ships a **reference agent** — a proof-of-concept *producer*
for data catalogs (BQ pass: one concept per BigQuery asset; web pass:
LLM-as-bounded-crawler enriching concepts from seed URLs) — and a `viz.html`
generator as proof-of-concept *consumer*. Both are explicitly "one way":
OKF is declared universal and framework-agnostic; agent-memory bundles are a
different-but-intended use. Their bundles are regenerable projections of
external sources; ours are original records — same format, different stakes.

**The spec ships no agent guidance** — Google's samples (discovery/enrichment
SKILL.md) are for the GCP Knowledge Catalog product, not file bundles. The
craft in our `okf` packaged skill was distilled from the community:
sniperunder123/okf-knowledge (maintenance flows, log convention words),
stjbrown/agent-knowledge (trust model: supersede-with-provenance),
Sudhakaran88/okf-conformance (conformance errors vs producer lints).

# Citations

[1] [OKF SPEC.md](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
[2] [okf-knowledge /okf skill](https://github.com/sniperunder123/okf-knowledge)
[3] [agent-knowledge kb-* skills](https://github.com/stjbrown/agent-knowledge)
[4] [OKF conformance suite](https://github.com/Sudhakaran88/okf-conformance)
