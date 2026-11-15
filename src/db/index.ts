import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export interface CreateDbOptions {
  prepare?: boolean;
  max?: number;
}

const globalForDb = globalThis as unknown as {
  __fliprouterSql?: Sql;
  __fliprouterDb?: Database;
};

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

export function getDb(): Database {
  if (globalForDb.__fliprouterDb) {
    return globalForDb.__fliprouterDb;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL environment variable is required to initialize Drizzle.",
    );
  }

  const { client, db } = createDb(connectionString);
  globalForDb.__fliprouterSql = client;
  globalForDb.__fliprouterDb = db;
  return db;
}

export async function closeDb(): Promise<void> {
  const client = globalForDb.__fliprouterSql;
  globalForDb.__fliprouterSql = undefined;
  globalForDb.__fliprouterDb = undefined;
  if (client) {
    await client.end({ timeout: 5 });
  }
}

export * from "./schema";
