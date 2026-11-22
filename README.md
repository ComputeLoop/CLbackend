# Compute Loop workspace API

```sh
bun install --frozen-lockfile
bun run db:init
bun run src/index.ts
```

The API defaults to `http://localhost:6767`. It serves cookie-based auth at `/auth` and workspace workflows at `/team`. Researchers publish worker ZIPs or release links and run instructions. Workspace members claim tasks and upload results through the dashboard using their account session. Database initialization is additive; use a separate database and storage directory for an exhibition rehearsal.

| Setting | Purpose |
| --- | --- |
| `DB_PATH` | SQLite file; defaults to `./computeloop.db` |
| `STORAGE_DIR` | Local application, input, and result storage; defaults to `./storage` |
| `CORS_ORIGINS` | Additional comma-separated allowed dashboard origins |
| `PUBLIC_API_URL` | Public API origin for same-origin request checks |
| `DEMO_IDR_PER_COIN` | Simulated rupiah per compute coin; default 1,000 |
| `DEMO_SUBSCRIPTION_COINS` | Simulated 30-day subscription price; default 30 coins |

Local demo files and integration tests are kept out of Git and the Docker image. If you have the local `integration/` directory, run `bun run test` to test against an isolated SQLite database and storage directory.
