"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { CatalogSyncJobSnapshot, CatalogSyncMode } from "@/lib/catalog";
import { cn } from "@/lib/utils";

interface CatalogSyncBannerProps {
  dbMode: "postgres" | "pglite";
  sync: CatalogSyncJobSnapshot;
  isTriggeringSync: boolean;
  onStartSync: (mode: CatalogSyncMode) => Promise<void>;
}

const STAGE_STEPS = [
  { num: 1, label: "1. Scryfall Bulk" },
  { num: 2, label: "2. MTGJSON IDs" },
  { num: 3, label: "3. Daily Prices" },
  { num: 4, label: "4. Mana Pool NM" },
] as const;

function formatRelativeOrShortTime(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CatalogSyncBanner({
  dbMode,
  sync,
  isTriggeringSync,
  onStartSync,
}: CatalogSyncBannerProps): React.ReactElement {
  const isRunning = sync.state === "running" || isTriggeringSync;
  const formattedCount = sync.catalogCount.toLocaleString("en-US");
  const lastSyncedLabel = formatRelativeOrShortTime(sync.lastSyncedAt);

  return (
    <section
      aria-label="Local MTG Card Catalog Sync Status"
      className={cn(
        "rounded-2xl border px-4 py-3 shadow-md transition",
        isRunning
          ? "border-sky-500/45 bg-sky-950/25"
          : sync.isFullCatalog
            ? "border-emerald-500/30 bg-slate-900/75"
            : "border-amber-500/35 bg-slate-900/80",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg border",
              sync.isFullCatalog
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                : "border-amber-500/40 bg-amber-500/15 text-amber-300",
            )}
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin text-sky-300" />
            ) : (
              <Database className="h-4 w-4" />
            )}
          </div>

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-white">
                {sync.isFullCatalog
                  ? `${formattedCount} MTG Printings Indexed`
                  : `${formattedCount} Demo Printings Loaded`}
              </span>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold",
                  sync.isFullCatalog
                    ? "border-emerald-500/35 bg-emerald-500/15 text-emerald-300"
                    : "border-amber-500/35 bg-amber-500/15 text-amber-200",
                )}
              >
                {sync.isFullCatalog ? "FULL CATALOG READY" : "DEMO SEED"}
              </span>
              <span className="font-mono text-[11px] text-slate-400">
                {dbMode === "postgres" ? "PostgreSQL" : "Local PGlite (.data/pglite)"}
                {lastSyncedLabel ? ` · Updated ${lastSyncedLabel}` : ""}
              </span>
            </div>

            <p className="mt-0.5 text-[11px] text-slate-400">
              {sync.isFullCatalog
                ? "95% Local DB Rule active: Scryfall default_cards + MTGJSON AllPricesToday + Card Kingdom buylist + Mana Pool NM singles."
                : "Sync the full 100k+ Scryfall + MTGJSON + Mana Pool catalog into local PGlite to resolve any personal or friend collection CSV."}
            </p>
          </div>
        </div>

        {/* Sync Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {sync.isFullCatalog ? (
            <>
              <button
                type="button"
                disabled={isRunning}
                onClick={() => onStartSync("prices_only")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw
                  className={cn("h-3.5 w-3.5", isRunning && "animate-spin")}
                />
                Refresh Daily Prices
              </button>
              <button
                type="button"
                disabled={isRunning}
                onClick={() => onStartSync("full")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Full Catalog Re-Sync
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={isRunning}
              onClick={() => onStartSync("full")}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 shadow-sm hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Sync Full 100k+ Catalog
            </button>
          )}
        </div>
      </div>

      {/* Live 4-Stage Streaming Sync Progress Bar */}
      {isRunning && (
        <div className="mt-3 space-y-2 border-t border-slate-800/90 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-medium text-sky-200">{sync.stageLabel}</span>
            <span className="font-mono text-[11px] text-slate-300">
              Seen: {sync.rowsSeen.toLocaleString("en-US")} · Upserted/Updated:{" "}
              {sync.rowsWritten.toLocaleString("en-US")} · Elapsed:{" "}
              {Math.floor((sync.durationMs ?? 0) / 1000)}s
            </span>
          </div>

          <div className="grid grid-cols-4 gap-1.5">
            {STAGE_STEPS.map((step) => {
              const isDone = sync.stageNumber > step.num;
              const isCurrent = sync.stageNumber === step.num;
              return (
                <div
                  key={step.num}
                  className={cn(
                    "rounded-lg border px-2.5 py-1 text-center font-mono text-[10px] font-semibold transition",
                    isDone
                      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                      : isCurrent
                        ? "border-sky-400/60 bg-sky-500/20 text-sky-200 animate-pulse"
                        : "border-slate-800 bg-slate-950/70 text-slate-500",
                  )}
                >
                  {step.label}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Completed Notice */}
      {!isRunning && sync.state === "completed" && sync.stats && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-2 text-[11px] text-emerald-300">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Synced {sync.stats.finalCatalogCount.toLocaleString("en-US")}{" "}
            printings in {Math.round(sync.stats.durationMs / 1000)}s (Scryfall:{" "}
            {sync.stats.scryfallUpserted.toLocaleString("en-US")} · MTGJSON
            Prices: {sync.stats.pricesUpdated.toLocaleString("en-US")} · Mana
            Pool: {sync.stats.manapoolSupplemented.toLocaleString("en-US")})
          </span>
          {sync.warning && (
            <span className="text-amber-300">Note: {sync.warning}</span>
          )}
        </div>
      )}

      {/* Failed Notice */}
      {!isRunning && sync.state === "failed" && sync.error && (
        <div
          role="alert"
          className="mt-2.5 flex items-center gap-2 border-t border-rose-500/30 pt-2 text-xs text-rose-300"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
          <span>Catalog sync failed: {sync.error}</span>
        </div>
      )}
    </section>
  );
}
