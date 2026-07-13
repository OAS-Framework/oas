---
name: oas-support
description: >-
  Route deep OAS framework questions to the framework's own expert agent.
  Use when a user asks how OAS works beyond the basics in the oas skill, why
  the framework behaves a certain way, wants framework changes or roadmap
  context, or hits framework bugs — the answer is to instantiate the
  oas-expert soul from the oas-framework repo and delegate. Triggers: "ask
  the OAS experts", "why does OAS do X", "is this an OAS bug", "OAS
  architecture question", "who maintains this framework".
---

# OAS support — delegate to the framework's expert

The oas-framework repo carries its own agents. The **oas-expert** soul holds
the framework's architecture record, decisions, and roadmap — knowledge no
generic session has. For deep questions, instantiate it and let the user
talk to it directly. Do not guess at framework internals yourself.

## 1. Find the oas-framework repo locally

Check in this order. Verify a hit by remote URL — it must point at
`oas-framework`:

```bash
# a) an existing pi install from a local path IS the repo
python3 -c "import json,os; [print(p if isinstance(p,str) else p.get('source','')) for p in json.load(open(os.path.expanduser('~/.pi/agent/settings.json'))).get('packages',[])]"
# b) common spots
ls -d ~/oas-framework 2>/dev/null
# c) verify any candidate
git -C <candidate> remote get-url origin   # expect .../oas-framework
```

**Do not use a pi-managed git clone** (`~/.pi/agent/git/...`) as the home
for agent instantiation. `pi update` resets and cleans those clones, which
would wipe the souls' accumulated knowledge.

## 2. If not found, ask the user where to clone

Never pick a location silently. Suggest `~/oas-framework` or a sibling of
their workspace, then:

```bash
git clone https://github.com/OAS-Framework/oas <chosen-path>
```

## 3. Instantiate the oas-expert soul

Spawn from the repo's own agents root (`--dir` targets it regardless of
where your session runs):

```bash
oas spawn oas-expert --dir <repo> --purpose <short-slug> \
  --task "<the user question, plus their workspace path and any config context>"
```

Include in the task briefing: the user's actual question, their workspace
path, and relevant `oas doctor` output. The expert reads its soul knowledge
and answers with citations.

## 4. Hand off

Tell the user the instance is running and how to reach it:
`tmux attach -t pi-agents`, then pick the window. Report the window name.
Retirement is the user's call (or yours if they delegate it) — retiring
harvests the instance's notes back into the expert's soul.

## Scope note

Quick questions (home layout, roster, lifecycle, doctor) are already
answered by the **oas** skill — use that first. Delegate to the expert for
architecture, design rationale, roadmap, and anything you would otherwise
guess about.
