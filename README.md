# FlipRouter MTG

Backpack Vendor & Collection Flipper Triage Suite for Magic: The Gathering collections.

See [`docs/SPEC.md`](./docs/SPEC.md) for the full product specification, database schema, deterministic 4-bucket liquidation math, scanner CSV normalization rules, and nightly Scryfall + MTGJSON ingestion pipeline.

## Quickstart

### Zero-Config Local App (`npm run dev` — Windows, macOS, & Linux)

When `DATABASE_URL` is unset, FlipRouter MTG automatically initializes an embedded persistent PostgreSQL instance via `@electric-sql/pglite` (`.data/pglite`), runs Drizzle migrations, and seeds a 44-card canonical MTG starter catalog + 24h SKU cache so the workspace opens immediately:

```bash
npm install
npm run dev
# Open http://localhost:3000
```

### Full 110k+ MTG Card Catalog Sync (No Python Required Locally)

Click **Sync Full 100k+ Catalog** directly in the web UI banner at `http://localhost:3000`, or run the pure Node.js / TypeScript streaming sync CLI (automatically delegates to a running `:3000` dev server if active):

```bash
# Full 4-stage sync (~111,000 paper MTG printings + MTGJSON IDs + daily prices + Mana Pool NM)
npm run catalog:sync

# Fast ~40s daily vendor price refresh once full catalog is indexed
npm run catalog:sync -- --prices-only
```

### TypeScript, Build, & Drizzle ORM Database Layer

```bash
npm run db:seed     # Seed/refresh 44-card starter fixtures (delegates to :3000 if active)
npm run typecheck   # Strict TypeScript check
npm test            # Vitest unit + PGlite integration suite
npm run build       # Next.js App Router production build
npm run db:generate # Generate Drizzle SQL migrations
```

### Python 3.12 Server Cron Sync (`scripts/sync_catalog.py`)

```bash
python3 -m pip install -r scripts/requirements.txt

# Smoke test streaming ingestion without writing to PostgreSQL
python3 scripts/sync_catalog.py --dry-run --limit 100

# Full sync into PostgreSQL (04:00 UTC server cron)
DATABASE_URL="postgresql://..." python3 scripts/sync_catalog.py
```
