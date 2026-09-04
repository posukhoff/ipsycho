## What changed and why

<!-- One paragraph: the user-visible change and the mechanism behind it. -->

## Checklist (from AGENTS.md)

- [ ] `npm run check` is green; `npm run test:e2e` was run for SQL, repository or transaction changes
- [ ] Every query is scoped by `workspaceId`; mutations and their action journal share one transaction
- [ ] Provider consent is checked at the provider boundary; no new path sends user text without it
- [ ] Logs carry identifiers and counters only, never message bodies, secrets or raw provider payloads
- [ ] Schema changes come as a new numbered migration; applied migrations are not edited
- [ ] User-facing copy exists in `ru`, `uk` and `en`
- [ ] Docs (`README.md`, `docs/`, `MANUAL_ACTIONS.md`) updated where behaviour changed
- [ ] `.env` was not read, printed or modified
