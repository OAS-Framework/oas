## Messaging: aweb

Your messaging layer is **aweb**. You have (or will be minted) a team-scoped
aweb identity — alias = your instance name. Use `aw mail` / `aw chat` for
async/sync messaging with your team (see the **aweb-messaging** skill).
Discovery: `oas status --team` lists this machine's souls and live instances;
`oas aweb roster` lists the aweb team's members across machines (OAS aliases
are instance names — message any of them directly).
Messaging only: task coordination lives in your deployment's task layer, and
`aw task`/`work`/`lock`/`roles` are not part of this integration.
