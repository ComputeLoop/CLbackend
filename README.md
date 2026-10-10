# Compute Loop — backend

Elysia (Bun) API server for the distributed compute marketplace: auth,
projects, dataset upload/detection/chunking, worker queue, auto-merge, and
HMAC-signed object storage.

## Run

```bash
bun install
bun run db:init          # create/upgrade SQLite schema (idempotent)
bun run src/index.ts     # dev with --watch: bun run dev
```

Server: **http://localhost:6767** — see [`../TESTING.md`](../TESTING.md) for the
full user-facing walkthrough.

## Main routes

- `GET /health`, `GET /operations` — op registry (`image-hash`, `tabular-stats`,
  `image-classify` — same definitions the worker runs)
- `POST /auth/register|login|logout`, `GET /auth/me` — cookie sessions
- `GET/POST /projects`, `GET /projects/:id`, `GET /projects/:id/jobs`
- `POST /projects/:id/dataset` — multipart upload (`dataset.zip`,
  `.csv/.tsv/.jsonl`), detects format, extracts file list or scans tabular
- `POST /projects/:id/split` — plans chunks (`itemsPerChunk` for file-lists,
  `rowsPerChunk` for tabular), writes chunk manifests with exact byte ranges
- `GET /chunks/next` — worker claim (atomic, sweeps stale RUNNING first)
- `POST /chunks/complete|fail`, `POST /workers/heartbeat` — worker lifecycle
- `POST /projects/:id/merge` — auto-fires on last chunk; JSONL concat (file-list)
  or JSON array (tabular), guarded by `merged_at`
- `GET /projects/:id/result` — signed download URL
- `GET/POST /workers[/register]` — contributor worker registry
- `GET /storage/GET|<key>?exp=&sig=` — HMAC-signed object downloads with
  `Range` support (byte-range chunk downloads)

## Key modules

| File | Contents |
| --- | --- |
| `src/index.ts` | Server listener entrypoint |
| `src/app.ts` | Elysia app configuration, CORS, error handling, and route composition |
| `src/config.ts` | Centralized environment and default configuration |
| `src/routes/` | Modular route controllers (`auth`, `projects`, `explore`, `chunks`, `workers`, `storage`) |
| `src/services/` | Business logic services (`auth`, `projects`, `storage`, `dataset`, `operations`) |
| `src/db/schema.ts`, `src/db/init.ts` | Drizzle ORM schema, typed models, and idempotent database initialization |
| `scripts/make-sample-dataset.ts` | Regenerates `sample-data/dataset.zip` + `sales.csv` |

## Configuration

| Env | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_API_URL` | `http://localhost:6767` | base for signed storage URLs |
| `STORAGE_SECRET` | random | HMAC key for signed URLs |
| `STORAGE_DIR` | `./storage` | object storage root (`objects/{datasets,projects}/…`) |
| `DB_PATH` | `./computeloop.db` | SQLite path |
| `WORKER_LEASE_MS` | `900000` | recycle stale RUNNING chunks after this |
| `MAX_FAIL_ATTEMPTS` | `3` | retries before a chunk is FAILED |

## Reset

```bash
rm -f computeloop.db && rm -rf storage/objects && bun run db:init
```