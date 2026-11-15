import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";

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
  __fliprouterInitPromise?: Promise<ReadyDbContext>;
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
  if (globalForDb.__fliprouterDb && globalForDb.__fliprouterDbMode === desiredMode) {
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

/**
 * Ensures the active database is migrated and (when empty in local prototype mode
 * or when `autoSeed` is enabled) seeded with the demo MTG catalog + SKU cache.
 * Concurrent callers share a single initialization promise.
 */
export async function getReadyDb(options: {
  autoSeed?: boolean;
} = {}): Promise<ReadyDbContext> {
  const desiredMode = getDbMode();

  // Reset cached init promise if env switched between postgres and pglite (e.g. in tests)
  if (
    globalForDb.__fliprouterDbMode &&
    globalForDb.__fliprouterDbMode !== desiredMode
  ) {
    await closeDb();
  }

  if (!globalForDb.__fliprouterInitPromise) {
    globalForDb.__fliprouterInitPromise = (async () => {
      const db = getDb();
      const mode = getDbMode();
      let seededCount = 0;

      if (mode === "pglite") {
        await migratePglite(
          db as unknown as ReturnType<typeof drizzlePglite<typeof schema>>,
          {
            migrationsFolder: resolveMigrationsFolder(),
          },
        );
      }

      const shouldAutoSeed =
        options.autoSeed ??
        (mode === "pglite" && process.env.FLIPROUTER_AUTO_SEED !== "false");

      if (shouldAutoSeed) {
        const { seedDemoCatalogIfEmpty } = await import("./seed-demo");
        const result = await seedDemoCatalogIfEmpty(db);
        seededCount = result.insertedCatalogCount;
      }

      return { db, mode, seededCount };
    })().catch((err) => {
      globalForDb.__fliprouterInitPromise = undefined;
      throw err;
    });
  }

  return globalForDb.__fliprouterInitPromise;
}

export async function closeDb(): Promise<void> {
  const sqlClient = globalForDb.__fliprouterSql;
  const pgliteClient = globalForDb.__fliprouterPglite;
  globalForDb.__fliprouterSql = undefined;
  globalForDb.__fliprouterPglite = undefined;
  globalForDb.__fliprouterDb = undefined;
  globalForDb.__fliprouterDbMode = undefined;
  globalForDb.__fliprouterInitPromise = undefined;

  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
  }
  if (pgliteClient) {
    await pgliteClient.close();
  }
}

export * from "./schema";
