import { sql } from "drizzle-orm";
import type { Database } from "@/db/index";
import { cardCatalog } from "@/db/schema";
import { getCatalogCount } from "@/db/seed-demo";
import {
  type CatalogSyncProgressEvent,
  type CatalogSyncStats,
  type SyncFullCatalogOptions,
  type SyncStageKey,
  syncFullCatalog,
} from "./sync-full-catalog";

export type CatalogSyncRunState = "idle" | "running" | "completed" | "failed";
export type CatalogSyncMode = "full" | "prices_only";

export const FULL_CATALOG_MIN_THRESHOLD = 1000;

export interface CatalogSyncJobSnapshot {
  state: CatalogSyncRunState;
  mode: CatalogSyncMode;
  stageNumber: 0 | 1 | 2 | 3 | 4;
  stageKey: "idle" | SyncStageKey;
  stageLabel: string;
  rowsSeen: number;
  rowsWritten: number;
  batchesCompleted: number;
  catalogCount: number;
  isFullCatalog: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  lastSyncedAt: string | null;
  durationMs: number | null;
  stats: CatalogSyncStats | null;
  warning: string | null;
  error: string | null;
}

interface InternalSyncTracker {
  state: CatalogSyncRunState;
  mode: CatalogSyncMode;
  stageNumber: 0 | 1 | 2 | 3 | 4;
  stageKey: "idle" | SyncStageKey;
  stageLabel: string;
  rowsSeen: number;
  rowsWritten: number;
  batchesCompleted: number;
  cachedCatalogCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  lastSyncedAt: string | null;
  durationMs: number | null;
  stats: CatalogSyncStats | null;
  warning: string | null;
  error: string | null;
  activePromise: Promise<CatalogSyncStats> | null;
}

const globalForSync = globalThis as unknown as {
  __fliprouterCatalogSyncTracker?: InternalSyncTracker;
};

function getTracker(): InternalSyncTracker {
  if (!globalForSync.__fliprouterCatalogSyncTracker) {
    globalForSync.__fliprouterCatalogSyncTracker = {
      state: "idle",
      mode: "full",
      stageNumber: 0,
      stageKey: "idle",
      stageLabel: "Idle",
      rowsSeen: 0,
      rowsWritten: 0,
      batchesCompleted: 0,
      cachedCatalogCount: 0,
      startedAt: null,
      updatedAt: null,
      lastSyncedAt: null,
      durationMs: null,
      stats: null,
      warning: null,
      error: null,
      activePromise: null,
    };
  }
  return globalForSync.__fliprouterCatalogSyncTracker;
}

async function queryLastCatalogUpdatedIso(db: Database): Promise<string | null> {
  const rows = await db
    .select({ maxUpdated: sql<string | Date | null>`MAX(${cardCatalog.updatedAt})` })
    .from(cardCatalog);
  const val = rows[0]?.maxUpdated;
  if (!val) return null;
  const parsed = val instanceof Date ? val : new Date(String(val));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function getCatalogSyncSnapshot(
  db: Database,
): Promise<CatalogSyncJobSnapshot> {
  const tracker = getTracker();
  // Avoid queuing SELECT COUNT(*) behind single-connection PGlite batch transactions while running
  const catalogCount =
    tracker.state === "running"
      ? Math.max(tracker.cachedCatalogCount, tracker.stats?.scryfallUpserted ?? 0)
      : await getCatalogCount(db);
  if (tracker.state !== "running") {
    tracker.cachedCatalogCount = catalogCount;
  }
  const isFullCatalog = catalogCount >= FULL_CATALOG_MIN_THRESHOLD;

  let lastSyncedAt = tracker.lastSyncedAt;
  if (!lastSyncedAt && isFullCatalog && tracker.state !== "running") {
    lastSyncedAt = await queryLastCatalogUpdatedIso(db);
  }

  return {
    state: tracker.state,
    mode: tracker.mode,
    stageNumber: tracker.stageNumber,
    stageKey: tracker.stageKey,
    stageLabel: tracker.stageLabel,
    rowsSeen: tracker.rowsSeen,
    rowsWritten: tracker.rowsWritten,
    batchesCompleted: tracker.batchesCompleted,
    catalogCount,
    isFullCatalog,
    startedAt: tracker.startedAt,
    updatedAt: tracker.updatedAt,
    lastSyncedAt,
    durationMs: tracker.durationMs,
    stats: tracker.stats,
    warning: tracker.warning,
    error: tracker.error,
  };
}

export interface StartCatalogSyncJobOptions {
  mode?: CatalogSyncMode;
  syncOptions?: Omit<SyncFullCatalogOptions, "onProgress">;
}

export interface StartCatalogSyncJobResult {
  started: boolean;
  alreadyRunning: boolean;
  job: CatalogSyncJobSnapshot;
  promise: Promise<CatalogSyncStats>;
}

/**
 * Starts the singleton background catalog sync job if none is currently running,
 * preventing overlapping sync runs against PGlite or PostgreSQL.
 */
export async function startCatalogSyncJob(
  db: Database,
  options: StartCatalogSyncJobOptions = {},
): Promise<StartCatalogSyncJobResult> {
  const tracker = getTracker();

  if (tracker.activePromise) {
    const snapshot = await getCatalogSyncSnapshot(db);
    return {
      started: false,
      alreadyRunning: true,
      job: snapshot,
      promise: tracker.activePromise,
    };
  }

  const currentCount = await getCatalogCount(db);
  tracker.cachedCatalogCount = currentCount;
  const requestedMode = options.mode ?? "full";
  // Only allow prices_only shortcut if full catalog (>1,000 printings) is already indexed
  const effectiveMode: CatalogSyncMode =
    requestedMode === "prices_only" && currentCount >= FULL_CATALOG_MIN_THRESHOLD
      ? "prices_only"
      : "full";

  const nowIso = new Date().toISOString();
  const startedMs = Date.now();

  tracker.state = "running";
  tracker.mode = effectiveMode;
  tracker.stageNumber = effectiveMode === "prices_only" ? 3 : 1;
  tracker.stageKey = effectiveMode === "prices_only" ? "prices" : "scryfall";
  tracker.stageLabel =
    effectiveMode === "prices_only"
      ? "Stage 3/4: Starting daily vendor price refresh..."
      : "Stage 1/4: Starting full 100k+ MTG catalog sync...";
  tracker.rowsSeen = 0;
  tracker.rowsWritten = 0;
  tracker.batchesCompleted = 0;
  tracker.startedAt = nowIso;
  tracker.updatedAt = nowIso;
  tracker.durationMs = 0;
  tracker.stats = null;
  tracker.warning = null;
  tracker.error = null;

  const onProgress = (event: CatalogSyncProgressEvent) => {
    tracker.stageNumber = event.stageNumber;
    tracker.stageKey = event.stageKey;
    tracker.stageLabel = event.stageLabel;
    tracker.rowsSeen = event.rowsSeen;
    tracker.rowsWritten = event.rowsWritten;
    tracker.batchesCompleted = event.batchesCompleted;
    tracker.updatedAt = new Date().toISOString();
    tracker.durationMs = Date.now() - startedMs;
    tracker.stats = { ...event.stats };
    if (event.stats.manapoolWarning) {
      tracker.warning = event.stats.manapoolWarning;
    }
  };

  const runPromise = syncFullCatalog(db, {
    ...options.syncOptions,
    ...(effectiveMode === "prices_only"
      ? { skipScryfall: true, skipIdentifiers: true }
      : {}),
    onProgress,
  })
    .then((stats) => {
      const completedIso = new Date().toISOString();
      tracker.state = "completed";
      tracker.stageNumber = 4;
      tracker.stageKey = "finalize";
      tracker.stageLabel = `Sync complete (${stats.finalCatalogCount.toLocaleString("en-US")} MTG printings indexed).`;
      tracker.cachedCatalogCount = stats.finalCatalogCount;
      tracker.updatedAt = completedIso;
      tracker.lastSyncedAt = completedIso;
      tracker.durationMs = stats.durationMs;
      tracker.stats = stats;
      tracker.warning = stats.manapoolWarning;
      tracker.error = null;
      return stats;
    })
    .catch((err: unknown) => {
      const failedIso = new Date().toISOString();
      const message =
        err instanceof Error ? err.message : "Catalog sync failed.";
      tracker.state = "failed";
      tracker.updatedAt = failedIso;
      tracker.durationMs = Date.now() - startedMs;
      tracker.error = message;
      throw err;
    })
    .finally(() => {
      tracker.activePromise = null;
    });

  // Prevent unhandledRejection when callers run fire-and-forget via HTTP 202
  runPromise.catch(() => undefined);
  tracker.activePromise = runPromise;

  const initialSnapshot = await getCatalogSyncSnapshot(db);
  return {
    started: true,
    alreadyRunning: false,
    job: initialSnapshot,
    promise: runPromise,
  };
}

export async function awaitActiveCatalogSync(): Promise<CatalogSyncStats | null> {
  const tracker = getTracker();
  if (!tracker.activePromise) return null;
  return tracker.activePromise;
}

export async function resetCatalogSyncTrackerForTests(): Promise<void> {
  const tracker = getTracker();
  if (tracker.activePromise) {
    await tracker.activePromise.catch(() => undefined);
  }
  globalForSync.__fliprouterCatalogSyncTracker = undefined;
}
