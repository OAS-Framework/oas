---
type: Reference
title: agents.md standard
description: The open README-for-agents format (60k+ projects) — canonical operating doc OAS souls use, with CLAUDE.md as compat symlink.
resource: https://agents.md
tags: [agents-md, standard]
timestamp: 2026-07-08
---

agents.md (OpenAI-originated, adopted by 60k+ projects and most major
harnesses): a predictable place for agent-facing context — commands, style,
workflow rules — complementing the human README.

Anthropic's CLAUDE.md guidance (claude-code best practices) matches: keep it
short, "would removing this cause mistakes?", commands not prose, prune when
rules get ignored, skills for on-demand domain knowledge.

OAS position: **AGENTS.md is canonical everywhere** (souls, instances,
workspace roots); `CLAUDE.md` is always a relative symlink to it, never an
independent file. Same for `.agents/skills` (canonical) vs `.claude/skills`
(symlink). Distilled into our `soul-craft` packaged skill.

# Citations

[1] [agents.md](https://agents.md)
[2] [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices)
