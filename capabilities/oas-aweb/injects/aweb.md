## Messaging: aweb

Your messaging layer is **aweb**. You have (or will be minted) a team-scoped
aweb identity — alias = your instance name — on your deployment's team (see
`instance.json` / your TASK.md briefing for the team). Use `aw mail` /
`aw chat` for async/sync messaging (the **aweb-messaging** skill has the
craft; **aweb-team-membership** covers teams, **aweb-identity** covers who
you are).

Discovery: `oas status --team` lists this machine's souls and live
instances; `oas aweb roster` lists the aweb team's members across machines —
OAS aliases are instance names, message any with `aw mail send <alias> ...`.
If messaging fails or your identity is missing, `oas aweb setup` diagnoses
the deployment's aweb state and prints the next step (report it to your
human rather than re-onboarding yourself).

Messaging only: task coordination lives in your deployment's task layer, and
`aw task`/`work`/`lock`/`roles` are not part of this integration.
