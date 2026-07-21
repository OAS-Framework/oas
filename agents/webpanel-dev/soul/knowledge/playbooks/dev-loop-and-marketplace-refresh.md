---
type: Playbook
title: Dev loop — version bumps and the marketplace refresh dance
description: Every behavior change to oas-web must bump the version in capabilities/oas-web/oas.json, and updating a deployed marketplace install requires deleting the installed copy and its lock entry before reinstalling, then restarting the server and hard-refreshing the browser.
tags: [oas-web, playbook, versioning, marketplace, deploy]
timestamp: 2026-07-21
---

# Version discipline

`oas.web` is a marketplace capability locked by
`marketplace:oas.web@<version>` + sha256 integrity. **Bump `version` in
`capabilities/oas-web/oas.json` on every behavior change** — an unchanged
version means deployed installs can't be told apart from the old code, and
the lock's integrity check pins the old bytes. Convention observed:
UI/feature work bumps minor (0.3.0 → 0.4.0), fixes bump patch.

# Refreshing a deployed install during development

`oas install` skips when the capability is already acquired (even at an
outer scope), so a re-deploy is a manual dance:

```bash
# 1. bump the version in the source
sed -i '' 's/"version": "0.4.0"/"version": "0.5.0"/' capabilities/oas-web/oas.json

# 2. remove the installed copy AND its lock entry at the target scope
rm -rf <scope>/.agents/capabilities/installed/oas-web
python3 - <<'EOF'
import json, pathlib
p = pathlib.Path("<scope>/oas-lock.json")
d = json.loads(p.read_text()); d["capabilities"].pop("oas.web", None)
p.write_text(json.dumps(d, indent=2) + "\n")
EOF

# 3. reinstall from the marketplace (kernel's capabilities/ folder)
cd <scope> && oas install oas.web

# 4. restart the server on the new copy
pkill -f "oas-web.mjs start"
(nohup node <scope>/.agents/capabilities/installed/oas-web/bin/oas-web.mjs \
  start --port 4820 --dir <scope> > /tmp/oas-web.log 2>&1 &)

# 5. verify the new code is actually served (grep for a token unique to the change)
curl -s http://127.0.0.1:4820/ | grep -c "<new-token>"
```

Then **hard-refresh the browser** (Cmd-Shift-R) — the single-file UI caches
aggressively during iteration and stale styling is a recurring false bug.

# Verification bar before shipping

Probe the **published artifact**, not the diff: in a clean throwaway scope,
`oas install oas.web` from the published kernel → check the lock source and
integrity → start the server → curl `/api/panel` and `/` for a token unique
to the release. Also verify the chat view live against a real session
(tool calls matched to results, running call rendered as running).
