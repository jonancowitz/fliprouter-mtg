import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { closeDb, getDbMode, getReadyDb } from "./index";
import {
  type CatalogSyncJobSnapshot,
  type CatalogSyncMode,
  syncFullCatalog,
} from "../lib/catalog";

interface CliOptions {
  mode: CatalogSyncMode;
  limit?: number;
  direct: boolean;
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  let mode: CatalogSyncMode = "full";
  let limit: number | undefined;
  let direct = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prices-only") {
      mode = "prices_only";
    } else if (arg === "--direct") {
      direct = true;
    } else if (arg === "--limit" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid --limit value: "${argv[i + 1]}"`);
      }
      limit = parsed;
      i += 1;
    } else if (arg?.startsWith("--limit=")) {
      const raw = arg.slice("--limit=".length);
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid --limit value: "${raw}"`);
      }
      limit = parsed;
    }
  }

  return { mode, limit, direct };
}

function formatProgressLine(
  stageLabel: string,
  rowsSeen: number,
  rowsWritten: number,
  elapsedMs: number,
): string {
  const secs = Math.floor(elapsedMs / 1000);
  return `[fliprouter:catalog:sync] (${secs}s) ${stageLabel} [seen=${rowsSeen.toLocaleString("en-US")}, written=${rowsWritten.toLocaleString("en-US")}]`;
}

async function tryRunViaActiveDevServer(
  cliOpts: CliOptions,
): Promise<boolean> {
  if (
    cliOpts.direct ||
    getDbMode() !== "pglite" ||
    Boolean(process.env.PGLITE_DATA_DIR?.trim())
  ) {
    return false;
  }

  const port = process.env.PORT?.trim() || "3000";
  const baseUrl = `http://127.0.0.1:${port}/api/catalog/sync`;

  let statusCheck: Response;
  try {
    statusCheck = await fetch(baseUrl, {
      method: "GET",
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    return false;
  }

  if (!statusCheck.ok) {
    return false;
  }

  const checkPayload = (await statusCheck.json()) as {
    ok?: boolean;
    dbMode?: string;
  };
  if (!checkPayload.ok || checkPayload.dbMode !== "pglite") {
    return false;
  }

  process.stdout.write(
    `[fliprouter:catalog:sync] Active Next.js PGlite server detected at ${baseUrl}; delegating sync (${cliOpts.mode})...\n`,
  );

  const triggerRes = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: cliOpts.mode,
      ...(cliOpts.limit !== undefined ? { limit: cliOpts.limit } : {}),
    }),
  });

  if (!triggerRes.ok) {
    const errBody = (await triggerRes.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      errBody.error ?? `Server returned HTTP ${triggerRes.status}`,
    );
  }

  let lastPrinted = "";
  let consecutivePollErrors = 0;
  while (true) {
    await delay(1000);
    let pollRes: Response;
    try {
      pollRes = await fetch(baseUrl, { cache: "no-store" });
      consecutivePollErrors = 0;
    } catch (pollErr) {
      consecutivePollErrors += 1;
      if (consecutivePollErrors >= 5) {
        throw pollErr;
      }
      continue;
    }
    if (!pollRes.ok) {
      throw new Error(`Lost connection to dev server (HTTP ${pollRes.status}).`);
    }
    const pollData = (await pollRes.json()) as {
      sync: CatalogSyncJobSnapshot;
    };
    const job = pollData.sync;

    const line = formatProgressLine(
      job.stageLabel,
      job.rowsSeen,
      job.rowsWritten,
      job.durationMs ?? 0,
    );
    if (line !== lastPrinted) {
      process.stdout.write(`${line}\n`);
      lastPrinted = line;
    }

    if (job.state === "completed") {
      process.stdout.write(
        `[fliprouter:catalog:sync] Completed! ${job.catalogCount.toLocaleString("en-US")} MTG printings indexed in ${Math.round((job.durationMs ?? 0) / 1000)}s.\n`,
      );
      if (job.warning) {
        process.stdout.write(
          `[fliprouter:catalog:sync] Warning: ${job.warning}\n`,
        );
      }
      return true;
    }

    if (job.state === "failed") {
      throw new Error(job.error ?? "Catalog sync failed on dev server.");
    }
  }
}

export async function runCatalogSyncCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const cliOpts = parseCliArgs(argv);

  if (await tryRunViaActiveDevServer(cliOpts)) {
    return;
  }

  try {
    const { db, mode } = await getReadyDb({ autoSeed: false });
    process.stdout.write(
      `[fliprouter:catalog:sync] Starting direct ${cliOpts.mode} sync against ${mode}...\n`,
    );

    let lastStageKey = "";
    let lastBatchLog = 0;

    const stats = await syncFullCatalog(db, {
      ...(cliOpts.mode === "prices_only"
        ? { skipScryfall: true, skipIdentifiers: true }
        : {}),
      ...(cliOpts.limit !== undefined ? { limit: cliOpts.limit } : {}),
      onProgress: (ev) => {
        if (
          ev.stageKey !== lastStageKey ||
          ev.batchesCompleted - lastBatchLog >= 20
        ) {
          lastStageKey = ev.stageKey;
          lastBatchLog = ev.batchesCompleted;
          process.stdout.write(
            `${formatProgressLine(
              ev.stageLabel,
              ev.rowsSeen,
              ev.rowsWritten,
              ev.stats.durationMs,
            )}\n`,
          );
        }
      },
    });

    process.stdout.write(
      `[fliprouter:catalog:sync] Completed! ${stats.finalCatalogCount.toLocaleString("en-US")} MTG printings indexed in ${Math.round(stats.durationMs / 1000)}s (Scryfall=${stats.scryfallUpserted}, Identifiers=${stats.identifiersMapped}, Prices=${stats.pricesUpdated}, ManaPool=${stats.manapoolSupplemented}).\n`,
    );
    if (stats.manapoolWarning) {
      process.stdout.write(
        `[fliprouter:catalog:sync] Warning: ${stats.manapoolWarning}\n`,
      );
    }
  } finally {
    await closeDb();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runCatalogSyncCli().catch((err: unknown) => {
    console.error("[fliprouter:catalog:sync] Failed:", err);
    process.exitCode = 1;
  });
}
