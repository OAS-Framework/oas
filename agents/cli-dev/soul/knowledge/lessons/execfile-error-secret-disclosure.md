---
type: Lesson
title: execFileSync errors carry the full argv, so a failed command discloses its secrets
description: A failing `aw team join` put a still-valid team invite token into the hook's error text, which the kernel then surfaced into CLI and Desktop logs.
tags: [security, secrets, capabilities, hooks, logging]
timestamp: 2026-07-27
---

# Lesson

`execFileSync` builds its error message as `Command failed: <program> <every argument>`.
Switching from a shell string to argv removes the INJECTION class, and it is worth doing —
but it does nothing about DISCLOSURE, and I had treated the argv conversion as if it made
the call site safe. A failed `aw team join <invite-token> …` handed the token to the catch
block, which put it in the hook's fatal message, which the kernel prints and stores.

**Any command whose arguments include a credential needs its failure path rebuilt from
scratch: program name, exit status, stderr — never the argv.** And scrub the secret from
stderr too, because the command may echo back what it rejected ("invalid token: …"). The
caller is the only party that knows which argument was sensitive, so it has to say so:

    run(["aw", "team", "join", token, …], home, timeout, [token])   // last arg: scrub these

The blast radius is what makes it worth the care. This is a REQUIRED spawn hook, so its
error text reaches every operator log, the Desktop UI, and any human debugging a failed
spawn — none of whom are necessarily authorized to join that team.

# Scrubbing fails for the command that MINTS the secret

Naming the secret works for the command that SPENDS it — the caller holds the token and can
say "redact this". It cannot work for the command that CREATES it: when `aw team invite`
fails after printing a freshly-minted token to stderr, the caller has no value to scrub,
because the token is precisely what it never received. Same for a malformed JSON reply:
`JSON.parse` quotes the input in its `SyntaxError`, and for these commands the input IS the
credential.

So credential-handling commands need a mode that discards the child's OUTPUT entirely —
status plus fixed context is all the diagnosis anyone gets — and a JSON parser whose failure
never quotes what it was given. **Redaction is for secrets you know; suppression is for
secrets you cannot know.** A command that mints credentials always needs the second.

# The SUCCESS path is an output channel too

Suppressing every failure path still left the token printable on exit 0. A join reply is
copied into the instance's metadata and its briefing, so a response echoing the invite token
back as the alias printed it twice, with status 0 and nothing to diagnose. I had spent two
rounds hardening errors while the happy path copied a remote system's strings straight into
a durable file.

**Treat a command's OUTPUT as untrusted input, not as data you already own.** Validate each
field as a plausible value of its own kind (an alias looks like an alias, a team id like a
team id), reject anything carrying a secret you hold, and fall back to the value YOU
requested — which you always know, because you asked for it. That last point is what makes
the check free of judgement calls: there is a correct answer available locally for every
field worth emitting.

Generalisation worth keeping: an error message is an output channel with the same
disclosure rules as any other. Whatever the failing operation held, its exception is holding
too.
