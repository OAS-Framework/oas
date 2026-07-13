---
type: Lesson
title: npm package export maps must expose package.json
description: When an OAS npm package adds an exports map, expose ./package.json and use a files whitelist before publishing to keep tooling working and private agent state out of the tarball.
tags: [npm, releases, packaging, gotcha]
timestamp: 2026-07-10
---

Adding an `exports` field to `package.json` makes Node enforce the export map
strictly. Anything not listed becomes unimportable, including
`./package.json`.

# The lesson

1. **Expose the manifest deliberately.** For OAS packages that pi, harnesses,
   or other tooling inspect through package resolution, include an explicit
   export such as `"./package.json": "./package.json"` alongside the code
   entry points.
2. **Treat the `files` whitelist as release-critical.** Before first publish,
   whitelist the directories that belong in the npm tarball. In this repo,
   omitting `files` would have shipped `agents/` — souls, instances, and
   private knowledge — in the package.
3. **Check packaging after changing package shape.** A package can work from
   the checkout while failing once installed if consumers rely on a path not
   exposed by `exports`, or if `npm pack` includes unintended workspace state.
