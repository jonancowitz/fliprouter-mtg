# FlipRouter MTG

Backpack Vendor & Collection Flipper Triage Suite for Magic: The Gathering collections.

See [`docs/SPEC.md`](./docs/SPEC.md) for the full product specification, database schema, deterministic 4-bucket liquidation math, scanner CSV normalization rules, and nightly Scryfall + MTGJSON ingestion pipeline.

## Quickstart

### TypeScript & Drizzle ORM Database Layer

```bash
npm install
npm run typecheck
npm test
npm run db:generate
```

### Python 3.12 Nightly Catalog Sync (`scripts/sync_catalog.py`)

```bash
python3 -m pip install -r scripts/requirements.txt

# Smoke test streaming ingestion without writing to PostgreSQL
python3 scripts/sync_catalog.py --dry-run --limit 100

# Full sync into PostgreSQL (04:00 UTC cron)
DATABASE_URL="postgresql://..." python3 scripts/sync_catalog.py
```
