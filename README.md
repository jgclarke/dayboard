# dayboard

A tool for tracking my daily tasks. Three columns: **Floating**, **Today**, **Coming up**. Runs on [Spacefast](https://spacefast.com) (Zero runtime) at https://jgclarke-dayboard.space.fast/.

## What works now

- Own tasks: quick add with plain-language dates ("tomorrow", "fri"), inline edit with details, delete, done with undo.
- Drag between columns to change the date; drag within a column to reorder the view.
- Overdue tasks at the top of Today, with a bulk "Move all to today".
- Recurring tasks (every weekday, or one weekday a week). Missed copies stack.
- Saved to the space's database, cached locally, and retried if a save fails. Syncs across devices.
- Claude can **read** tasks through the Spacefast API (`getSpaceDatabaseDump`, table `items`).

Linear and HubSpot cards are styled but not wired up yet. See the issues.

## Layout

| File | What it is |
| --- | --- |
| `sf.jsonc` | Spacefast app config (`runtime.kind: "zero"`) |
| `server/index.ts` | Capsule: one `items` table plus `GET /api/state`, `POST /api/ops`, `GET /api/health` |
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
