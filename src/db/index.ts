import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";
import type { SeedDemoResult } from "./seed-demo";

export type Database = PostgresJsDatabase<typeof schema>;
export type DbRuntimeMode = "postgres" | "pglite";

export interface CreateDbOptions {
  prepare?: boolean;
  max?: number;
}

export interface ReadyDbContext {
  db: Database;
  mode: DbRuntimeMode;
  seededCount: number;
}

const globalForDb = globalThis as unknown as {
  __fliprouterSql?: Sql;
  __fliprouterPglite?: PGlite;
  __fliprouterDb?: Database;
  __fliprouterDbMode?: DbRuntimeMode;
  __fliprouterMigratePromise?: Promise<{ db: Database; mode: DbRuntimeMode }>;
  __fliprouterSeedPromise?: Promise<number>;
  __fliprouterClosePromise?: Promise<void>;
};

export function resolvePgliteDataDir(): string {
  const configured = process.env.PGLITE_DATA_DIR?.trim();
  if (configured) {
    return configured;
  }
  return path.resolve(process.cwd(), ".data/pglite");
}

export function resolveMigrationsFolder(): string {
  return path.resolve(process.cwd(), "drizzle");
}

export function createDb(
  connectionString: string,
  options: CreateDbOptions = {},
): { client: Sql; db: Database } {
  const prepare =
    options.prepare ?? process.env.DATABASE_PREPARE !== "false";
  const client = postgres(connectionString, {
    prepare,
    max: options.max ?? 10,
  });
  const db = drizzle(client, { schema });
  return { client, db };
}

export function createPgliteDb(dataDir: string = resolvePgliteDataDir()): {
  client: PGlite;
  db: Database;
} {
  if (dataDir !== "memory://" && !dataDir.startsWith("idb://")) {
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  }
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema }) as unknown as Database;
  return { client, db };
}

export function getDbMode(): DbRuntimeMode {
  return process.env.DATABASE_URL?.trim() ? "postgres" : "pglite";
}

/**
 * Returns the active Drizzle database instance:
 * - Uses `postgres-js` when `DATABASE_URL` is configured.
 * - Falls back to persistent local PGlite (`.data/pglite` or `PGLITE_DATA_DIR`)
 *   when `DATABASE_URL` is unset so `npm run dev` works with zero external setup.
 */
export function getDb(): Database {
  const desiredMode = getDbMode();
  if (
    globalForDb.__fliprouterDb &&
    globalForDb.__fliprouterDbMode === desiredMode
  ) {
    return globalForDb.__fliprouterDb;
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString) {
    const { client, db } = createDb(connectionString);
    globalForDb.__fliprouterSql = client;
    globalForDb.__fliprouterDb = db;
    globalForDb.__fliprouterDbMode = "postgres";
    return db;
  }

  const { client, db } = createPgliteDb();
  globalForDb.__fliprouterPglite = client;
  globalForDb.__fliprouterDb = db;
  globalForDb.__fliprouterDbMode = "pglite";
  return db;
}

async function ensureMigratedDb(): Promise<{
  db: Database;
  mode: DbRuntimeMode;
}> {
  if (globalForDb.__fliprouterClosePromise) {
    await globalForDb.__fliprouterClosePromise;
  }

  const desiredMode = getDbMode();
  if (
    globalForDb.__fliprouterDbMode &&
    globalForDb.__fliprouterDbMode !== desiredMode
  ) {
    await closeDb();
  }

  if (!globalForDb.__fliprouterMigratePromise) {
    globalForDb.__fliprouterMigratePromise = (async () => {
      const db = getDb();
      const mode = getDbMode();
      if (mode === "pglite") {
        await migratePglite(
          db as unknown as ReturnType<typeof drizzlePglite<typeof schema>>,
          {
            migrationsFolder: resolveMigrationsFolder(),
          },
        );
      }
      return { db, mode };
    })().catch((err) => {
      globalForDb.__fliprouterMigratePromise = undefined;
      throw err;
    });
  }

  return globalForDb.__fliprouterMigratePromise;
}

/**
 * Ensures the active database is migrated and (when empty in local prototype mode
 * or when `FLIPROUTER_AUTO_SEED=true` / `options.autoSeed=true`) seeded with the
 * demo MTG catalog + SKU cache. Migration and seeding promises are tracked
 * independently so `getReadyDb({ autoSeed: false })` never poisons subsequent
 * `getReadyDb()` auto-seeding.
 */
export async function getReadyDb(
  options: {
    autoSeed?: boolean;
  } = {},
): Promise<ReadyDbContext> {
  const { db, mode } = await ensureMigratedDb();

  const shouldAutoSeed =
    options.autoSeed ??
    (process.env.FLIPROUTER_AUTO_SEED === "true" ||
      (mode === "pglite" && process.env.FLIPROUTER_AUTO_SEED !== "false"));

  if (!shouldAutoSeed) {
    if (globalForDb.__fliprouterSeedPromise) {
      const seededCount = await globalForDb.__fliprouterSeedPromise;
      return { db, mode, seededCount };
    }
    return { db, mode, seededCount: 0 };
  }

  if (!globalForDb.__fliprouterSeedPromise) {
    globalForDb.__fliprouterSeedPromise = (async () => {
      const { seedDemoCatalogIfEmpty } = await import("./seed-demo");
      const result = await seedDemoCatalogIfEmpty(db);
      return result.insertedCatalogCount;
    })().catch((err) => {
      globalForDb.__fliprouterSeedPromise = undefined;
      throw err;
    });
  }

  const seededCount = await globalForDb.__fliprouterSeedPromise;
  return { db, mode, seededCount };
}

/**
 * Runs an explicit transactional demo seed coordinated with `getReadyDb()` so
 * concurrent callers wait for seeding to complete before querying the catalog.
 */
export async function seedReadyDbCatalog(
  options: { now?: Date } = {},
): Promise<{
  db: Database;
  mode: DbRuntimeMode;
  seedResult: SeedDemoResult;
}> {
  const { db, mode } = await ensureMigratedDb();
  const priorSeed = globalForDb.__fliprouterSeedPromise;

  let capturedResult: SeedDemoResult | undefined;
  const nextSeedPromise = (async () => {
    if (priorSeed) {
      await priorSeed.catch(() => 0);
    }
    const { seedDemoCatalog } = await import("./seed-demo");
    capturedResult = await seedDemoCatalog(db, options);
    return capturedResult.insertedCatalogCount;
  })();

  globalForDb.__fliprouterSeedPromise = nextSeedPromise.catch((err) => {
    globalForDb.__fliprouterSeedPromise = undefined;
    throw err;
  });

  await globalForDb.__fliprouterSeedPromise;
  return {
    db,
    mode,
    seedResult: capturedResult!,
  };
}

export async function closeDb(): Promise<void> {
  if (globalForDb.__fliprouterClosePromise) {
    return globalForDb.__fliprouterClosePromise;
  }

  globalForDb.__fliprouterClosePromise = (async () => {
    const sqlClient = globalForDb.__fliprouterSql;
    const pgliteClient = globalForDb.__fliprouterPglite;
    const inflightMigrate = globalForDb.__fliprouterMigratePromise;
    const inflightSeed = globalForDb.__fliprouterSeedPromise;

    if (inflightMigrate) {
      await inflightMigrate.catch(() => undefined);
    }
    if (inflightSeed) {
      await inflightSeed.catch(() => undefined);
    }

    globalForDb.__fliprouterSql = undefined;
    globalForDb.__fliprouterPglite = undefined;
    globalForDb.__fliprouterDb = undefined;
    globalForDb.__fliprouterDbMode = undefined;
    globalForDb.__fliprouterMigratePromise = undefined;
    globalForDb.__fliprouterSeedPromise = undefined;

    if (sqlClient) {
      await sqlClient.end({ timeout: 5 });
    }
    if (pgliteClient) {
      await pgliteClient.close();
    }
  })().finally(() => {
    globalForDb.__fliprouterClosePromise = undefined;
  });

  return globalForDb.__fliprouterClosePromise;
}

export * from "./schema";
