# FlipRouter MTG

Backpack Vendor & Collection Flipper Triage Suite for Magic: The Gathering collections.

See [`docs/SPEC.md`](./docs/SPEC.md) for the full product specification, database schema, deterministic 4-bucket liquidation math, scanner CSV normalization rules, and nightly Scryfall + MTGJSON ingestion pipeline.

## Quickstart

### Zero-Config Local Prototype (`npm run dev`)

When `DATABASE_URL` is unset, FlipRouter MTG automatically initializes an embedded persistent PostgreSQL instance via `@electric-sql/pglite` (`.data/pglite`), runs Drizzle migrations, and seeds a 44-card MTG catalog + 24h SKU cache so the full 4-pile triage workspace works immediately:

```bash
npm install
npm run dev
# Open http://localhost:3000
```

### TypeScript, Build, & Drizzle ORM Database Layer

```bash
npm run db:seed     # Seed/refresh demo catalog (auto-delegates to POST /api/catalog/status if npm run dev is active on :3000)
npm run typecheck   # Strict TypeScript check
npm test            # Vitest unit + PGlite integration suite
npm run build       # Next.js App Router production build
npm run db:generate # Generate Drizzle SQL migrations
```

### Python 3.12 Nightly Catalog Sync (`scripts/sync_catalog.py`)

```bash
python3 -m pip install -r scripts/requirements.txt

# Smoke test streaming ingestion without writing to PostgreSQL
python3 scripts/sync_catalog.py --dry-run --limit 100

# Full sync into PostgreSQL (04:00 UTC cron)
DATABASE_URL="postgresql://..." python3 scripts/sync_catalog.py
```
