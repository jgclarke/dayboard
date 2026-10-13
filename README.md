# dayboard

A tool for tracking my daily tasks. Three columns: **Floating**, **Today**, **Coming up**. Runs on [Spacefast](https://spacefast.com) (Zero runtime) at https://jgclarke-dayboard.space.fast/.

## What works now

- Own tasks: quick add with plain-language dates ("tomorrow", "fri"), inline edit with details, delete, done with undo.
- Drag between columns to change the date; drag within a column to reorder the view.
- Overdue tasks at the top of Today, with a bulk "Move all to today".
- Recurring tasks (every weekday, or one weekday a week). Missed copies stack.
- Saved to the space's database, cached locally, and retried if a save fails. Syncs across devices.
- Claude can **read** tasks through the Spacefast API (`getSpaceDatabaseDump`, table `items`).

### Linear and HubSpot

Open Linear issues and HubSpot tasks assigned to Jason load live from `GET /api/external` on page load, on Sync, when the window regains focus (after 1 min), and every 10 minutes. Done and due-date changes go back through `POST /api/external/write`. "Done" waits out the 5-second undo window first.

Needs two **secret** space variables in Spacefast:

| Name | What |
| --- | --- |
| `LINEAR_API_KEY` | Linear personal API key (Settings → Account → Security & access) |
| `HUBSPOT_TOKEN` | HubSpot private app token with `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.companies.read` |

Optional: `HUBSPOT_OWNER_ID` and `HUBSPOT_PORTAL_ID` (default to Jason's).

## Layout

| File | What it is |
| --- | --- |
| `sf.jsonc` | Spacefast app config (`runtime.kind: "zero"`) |
| `server/index.ts` | Capsule: one `items` table plus `GET /api/state`, `POST /api/ops`, `GET /api/external`, `POST /api/external/write`, `GET /api/health` |
| `server/external.ts` | Linear GraphQL and HubSpot CRM calls |
| `index.html` | The whole UI: markup, styles and script in one file |

### Data model

One table, `items`, with columns `key`, `kind`, `data`.

- `key` is `task:<id>` or `series:<id>`.
- `kind` is `task` or `series`.
- `data` is the full JSON object.

Recurring instances get a deterministic id, `<seriesId>-<date>`, so two devices never create duplicates.

### API

- `GET /api/state` returns `{ tasks, series }`.
- `POST /api/ops` takes `{ ops: [{ op: "upsert", key, kind, data } | { op: "delete", key }] }`, at most 25 per request.

## Deploy

Publish the three files to the `jgclarke-dayboard` space. That can be done through the Spacefast CLI, or through Claude via the ContextA8C Spacefast provider.
