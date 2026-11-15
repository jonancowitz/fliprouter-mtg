"use client";

import {
  Boxes,
  Check,
  CheckCircle2,
  Database,
  Download,
  FolderKanban,
  Loader2,
  Save,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { AssignedBucket, CollectionLotStatus } from "@/db/schema";
import {
  DEMO_SCANNER_PRESETS,
  type DemoScannerPreset,
} from "@/lib/demo/scanner-presets";
import {
  type BuylistCashSelectionMode,
  DEFAULT_ROUTING_PROFILE,
  formatCentsToUsd,
  parseUsdToCents,
  routeCollectionLot,
} from "@/lib/routing";
import {
  hydrateRoutingCardInputs,
  hydrateRoutingProfile,
  type SavedLotDetailResponse,
  type SavedLotListItem,
  type SerializedRoutingCardInput,
  type SerializedRoutingProfile,
  serializeRoutingProfile,
  type TriageDiagnostics,
  type TriageIngestResponse,
} from "@/lib/triage/types";
import { cn } from "@/lib/utils";
import { ExportDrawer } from "./export-drawer";
import {
  formatUsdDisplay,
  getLotStatusMeta,
} from "./formatters";
import { PilesTable } from "./piles-table";
import { RoutingProfileControls } from "./routing-profile-controls";
import { SavedLotsDrawer } from "./saved-lots-drawer";
import { ScannerIngestPanel } from "./scanner-ingest-panel";

export interface TriageWorkspaceInitialState {
  dbMode: "postgres" | "pglite";
  catalogCount: number;
  initialPresetId: string;
  initialLotName: string;
  initialPurchaseCostUsd: string;
  initialDiagnostics: TriageDiagnostics;
  initialInputs: SerializedRoutingCardInput[];
  initialProfile: SerializedRoutingProfile;
  initialSavedLots: SavedLotListItem[];
}

export function TriageWorkspace({
  initial,
}: {
  initial: TriageWorkspaceInitialState;
}): React.ReactElement {
  const [activePresetId, setActivePresetId] = useState<string | null>(
    initial.initialPresetId,
  );
  const [activeLotId, setActiveLotId] = useState<string | null>(null);
  const [activeLotStatus, setActiveLotStatus] =
    useState<CollectionLotStatus>("triaged");
  const [lotName, setLotName] = useState(initial.initialLotName);
  const [purchaseCostInput, setPurchaseCostInput] = useState(
    initial.initialPurchaseCostUsd,
  );

  const [serializedInputs, setSerializedInputs] = useState<
    SerializedRoutingCardInput[]
  >(initial.initialInputs);
  const [diagnostics, setDiagnostics] = useState<TriageDiagnostics | null>(
    initial.initialDiagnostics,
  );
  const [profile, setProfile] = useState<SerializedRoutingProfile>(
    initial.initialProfile,
  );
  const [buylistCashMode, setBuylistCashMode] =
    useState<BuylistCashSelectionMode>("best");

  const [savedLots, setSavedLots] = useState<SavedLotListItem[]>(
    initial.initialSavedLots,
  );
  const [activeBucketFilter, setActiveBucketFilter] = useState<
    "ALL" | AssignedBucket | "QUARANTINED" | "DEMOTED"
  >("ALL");

  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [isSavingLot, setIsSavingLot] = useState(false);
  const [lotSaveBanner, setLotSaveBanner] = useState<string | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [exportDrawerOpen, setExportDrawerOpen] = useState(false);
  const [savedLotsDrawerOpen, setSavedLotsDrawerOpen] = useState(false);

  // Hydrate SKU cache dates once per ingested lot
  const hydratedCardInputs = useMemo(
    () => hydrateRoutingCardInputs(serializedInputs),
    [serializedInputs],
  );

  // Sanitize purchaseCostInput safely for live `bigint` recalculation
  const safePurchaseCostUsd = useMemo(() => {
    try {
      const parsed = parseUsdToCents(purchaseCostInput);
      if (parsed === null || parsed < 0n) return "0.00";
      return formatCentsToUsd(parsed);
    } catch {
      return "0.00";
    }
  }, [purchaseCostInput]);

  // Pure synchronous `bigint` routing recalculation on every slider/toggle/cost move!
  const routed = useMemo(() => {
    const hydratedProf = hydrateRoutingProfile(profile);
    return routeCollectionLot({
      purchaseCostUsd: safePurchaseCostUsd,
      items: hydratedCardInputs,
      profile: hydratedProf,
      options: { buylistCashMode },
    });
  }, [safePurchaseCostUsd, hydratedCardInputs, profile, buylistCashMode]);

  const computedLaborPerOrderUsd = useMemo(() => {
    const rateCents = parseUsdToCents(profile.hourlyLaborRateUsd) ?? 2000n;
    const secs = BigInt(Math.max(0, profile.secondsPerSingleOrder));
    const laborCents = (secs * rateCents * 2n + 3600n) / 7200n;
    return formatCentsToUsd(laborCents);
  }, [profile.hourlyLaborRateUsd, profile.secondsPerSingleOrder]);

  const isCogsReconciled =
    routed.summary.estimatedGrossValueCents === 0n ||
    routed.summary.allocatedCostBasisSumUsd === routed.summary.purchaseCostUsd;

  const handleChangeProfile = useCallback(
    (patch: Partial<SerializedRoutingProfile>) => {
      setProfile((prev) => ({ ...prev, ...patch }));
    },
    [],
  );

  const handleResetDefaults = useCallback(() => {
    setProfile((prev) => ({
      ...serializeRoutingProfile(DEFAULT_ROUTING_PROFILE),
      monthlySkuApiQuota: prev.monthlySkuApiQuota,
      monthlySkuApiUsed: prev.monthlySkuApiUsed,
    }));
    setBuylistCashMode("best");
  }, []);

  const refreshSavedLots = useCallback(async () => {
    const res = await fetch("/api/lots", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { lots: SavedLotListItem[] };
      setSavedLots(data.lots);
    }
  }, []);

  const runCsvIngest = useCallback(
    async (params: {
      csvText: string;
      presetId?: string | null;
      nextLotName?: string;
      nextPurchaseCostUsd?: string;
    }) => {
      setIsIngesting(true);
      setIngestError(null);
      try {
        const targetCost = params.nextPurchaseCostUsd ?? safePurchaseCostUsd;
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            csvText: params.csvText,
            purchaseCostUsd: targetCost,
            profile,
          }),
        });
        const payload = (await res.json()) as
          | TriageIngestResponse
          | { error: string };
        if (!res.ok || "error" in payload) {
          throw new Error(
            "error" in payload ? payload.error : "CSV ingestion failed.",
          );
        }

        setSerializedInputs(payload.inputs);
        setDiagnostics(payload.diagnostics);
        setActivePresetId(params.presetId ?? null);
        setActiveLotId(null);
        setActiveLotStatus("triaged");
        setActiveBucketFilter("ALL");
        if (params.nextLotName !== undefined) {
          setLotName(params.nextLotName);
        }
        if (params.nextPurchaseCostUsd !== undefined) {
          setPurchaseCostInput(params.nextPurchaseCostUsd);
        }
      } catch (err) {
        setIngestError(
          err instanceof Error ? err.message : "Failed to parse scanner CSV.",
        );
      } finally {
        setIsIngesting(false);
      }
    },
    [profile, safePurchaseCostUsd],
  );

  const handleSelectPreset = useCallback(
    async (preset: DemoScannerPreset) => {
      await runCsvIngest({
        csvText: preset.csvText,
        presetId: preset.id,
        nextLotName: preset.suggestedLotName,
        nextPurchaseCostUsd: preset.suggestedPurchaseCostUsd,
      });
    },
    [runCsvIngest],
  );

  const handleUploadCsvText = useCallback(
    async ({ csvText, filename }: { csvText: string; filename?: string }) => {
      const cleanName = filename
        ? filename.replace(/\.(csv|tsv|txt)$/i, "").replace(/[-_]+/g, " ")
        : "Uploaded Scanner Lot";
      await runCsvIngest({
        csvText,
        presetId: null,
        nextLotName: cleanName,
      });
    },
    [runCsvIngest],
  );

  const handleSaveLot = useCallback(async () => {
    if (serializedInputs.length === 0) return;
    setIsSavingLot(true);
    setIngestError(null);
    try {
      if (activeLotId) {
        const res = await fetch(`/api/lots/${activeLotId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lotName: lotName.trim() || "Untitled Acquisition Lot",
            purchaseCostUsd: safePurchaseCostUsd,
            profile,
            rerouteItems: true,
          }),
        });
        const data = (await res.json()) as
          | SavedLotDetailResponse
          | { error: string };
        if (!res.ok || "error" in data) {
          throw new Error("error" in data ? data.error : "Failed to update lot.");
        }
        setActiveLotStatus(data.lot.status);
        setLotSaveBanner(`Updated "${data.lot.lotName}"`);
      } else {
        const res = await fetch("/api/lots", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lotName: lotName.trim() || "Untitled Acquisition Lot",
            purchaseCostUsd: safePurchaseCostUsd,
            status: "triaged",
            inputs: serializedInputs,
            profile,
            persistProfile: true,
          }),
        });
        const data = (await res.json()) as
          | SavedLotDetailResponse
          | { error: string };
        if (!res.ok || "error" in data) {
          throw new Error("error" in data ? data.error : "Failed to save lot.");
        }
        setActiveLotId(data.lot.lotId);
        setActiveLotStatus(data.lot.status);
        setLotSaveBanner(`Saved "${data.lot.lotName}"`);
      }
      await refreshSavedLots();
      window.setTimeout(() => setLotSaveBanner(null), 2800);
    } catch (err) {
      setIngestError(
        err instanceof Error ? err.message : "Failed to save lot.",
      );
    } finally {
      setIsSavingLot(false);
    }
  }, [
    activeLotId,
    lotName,
    profile,
    refreshSavedLots,
    safePurchaseCostUsd,
    serializedInputs,
  ]);

  const handleLoadSavedLot = useCallback(async (targetLotId: string) => {
    const res = await fetch(`/api/lots/${targetLotId}`, { cache: "no-store" });
    const data = (await res.json()) as
      | SavedLotDetailResponse
      | { error: string };
    if (!res.ok || "error" in data) {
      setIngestError(
        "error" in data ? data.error : "Failed to load saved lot.",
      );
      return;
    }
    setActiveLotId(data.lot.lotId);
    setActiveLotStatus(data.lot.status);
    setActivePresetId(null);
    setLotName(data.lot.lotName);
    setPurchaseCostInput(data.lot.purchaseCostUsd);
    setSerializedInputs(data.inputs);
    setProfile(data.profile);
    setDiagnostics(null);
    setActiveBucketFilter("ALL");
  }, []);

  const handleUpdateLotSettlement = useCallback(
    async (
      targetLotId: string,
      patch: {
        status: CollectionLotStatus;
        actualRealizedPayoutUsd: string | null;
      },
    ) => {
      const res = await fetch(`/api/lots/${targetLotId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        if (targetLotId === activeLotId) {
          setActiveLotStatus(patch.status);
        }
        await refreshSavedLots();
      }
    },
    [activeLotId, refreshSavedLots],
  );

  const handleDeleteLot = useCallback(
    async (targetLotId: string) => {
      const res = await fetch(`/api/lots/${targetLotId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        if (activeLotId === targetLotId) {
          setActiveLotId(null);
        }
        await refreshSavedLots();
      }
    },
    [activeLotId, refreshSavedLots],
  );

  const handleSaveProfileDefault = useCallback(async () => {
    setIsSavingProfile(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (res.ok) {
        setLotSaveBanner("Saved default flipper profile");
        window.setTimeout(() => setLotSaveBanner(null), 2200);
      }
    } finally {
      setIsSavingProfile(false);
    }
  }, [profile]);

  const profitIsNegative = routed.summary.estimatedNetProfitCents < 0n;
  const activeStatusMeta = getLotStatusMeta(activeLotStatus);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-slate-950/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/15 text-emerald-300">
              <Boxes className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-white">
                  FlipRouter MTG
                </h1>
                <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300">
                  4-PILE ROUTER
                </span>
                <span className="hidden items-center gap-1 rounded-md border border-slate-800 bg-slate-900 px-2 py-0.5 font-mono text-[10px] text-slate-400 md:inline-flex">
                  <Database className="h-3 w-3 text-sky-400" />
                  {initial.dbMode === "postgres" ? "PostgreSQL" : "PGlite Local"}{" "}
                  · {initial.catalogCount} Catalog SKUs
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Backpack Vendor Liquidation Triage · Zero-Float{" "}
                <code className="font-mono">bigint</code> Fee &amp; Schedule C
                COGS Engine
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {lotSaveBanner && (
              <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-200">
                <Check className="h-3.5 w-3.5" />
                {lotSaveBanner}
              </span>
            )}

            <button
              type="button"
              onClick={() => setSavedLotsDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 hover:border-slate-700 hover:bg-slate-800"
            >
              <FolderKanban className="h-3.5 w-3.5 text-sky-400" />
              Saved Lots
              <span className="rounded bg-slate-800 px-1.5 py-0.2 font-mono text-[11px] text-slate-300">
                {savedLots.length}
              </span>
            </button>

            <button
              type="button"
              disabled={isSavingLot || serializedInputs.length === 0}
              onClick={handleSaveLot}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-40"
            >
              {isSavingLot ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {activeLotId ? "Update Saved Lot" : "Save Lot"}
            </button>

            <button
              type="button"
              onClick={() => setExportDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm shadow-emerald-950 hover:bg-emerald-500"
            >
              <Download className="h-3.5 w-3.5" />
              Export Manifests (5)
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-5 sm:px-6">
        {/* Acquisition Lot Header & Financial ROI Scoreboard */}
        <section className="rounded-2xl border border-slate-800/90 bg-slate-900/80 p-4 shadow-xl">
          <div className="grid gap-4 lg:grid-cols-12">
            {/* Lot Name & Acquisition Cost Inputs */}
            <div className="flex flex-col justify-between gap-3 lg:col-span-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Acquisition Lot
                </span>
                {activeLotId ? (
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                      activeStatusMeta.badgeClass,
                    )}
                  >
                    Saved · {activeStatusMeta.label}
                  </span>
                ) : (
                  <span className="rounded-full border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-[10px] text-slate-400">
                    Unsaved Workspace
                  </span>
                )}
              </div>

              <div className="grid gap-2.5 sm:grid-cols-12">
                <div className="sm:col-span-7">
                  <label
                    htmlFor="lot-name-input"
                    className="block text-[11px] text-slate-400"
                  >
                    Lot Name / Buyout Source
                  </label>
                  <input
                    id="lot-name-input"
                    type="text"
                    value={lotName}
                    onChange={(e) => setLotName(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm font-medium text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>

                <div className="sm:col-span-5">
                  <label
                    htmlFor="purchase-cost-input"
                    className="block text-[11px] text-slate-400"
                  >
                    Purchase Cost Paid (USD)
                  </label>
                  <div className="relative mt-1">
                    <span className="pointer-events-none absolute left-3 top-2 font-mono text-sm text-slate-400">
                      $
                    </span>
                    <input
                      id="purchase-cost-input"
                      type="text"
                      inputMode="decimal"
                      value={purchaseCostInput}
                      onChange={(e) => setPurchaseCostInput(e.target.value)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950 py-2 pl-7 pr-3 font-mono text-sm font-semibold text-white focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* IRS Schedule C Proportional FMV Reconciliation Pill */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800/90 bg-slate-950/80 px-3 py-1.5 text-xs">
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-slate-300">
                    IRS Schedule C COGS Basis:
                  </span>
                </div>
                <div className="flex items-center gap-1.5 font-mono text-[11px]">
                  <span className="text-slate-200">
                    &Sigma; Line Basis{" "}
                    <strong>
                      {formatUsdDisplay(
                        routed.summary.allocatedCostBasisSumUsd,
                      )}
                    </strong>{" "}
                    === Cost{" "}
                    <strong>
                      {formatUsdDisplay(routed.summary.purchaseCostUsd)}
                    </strong>
                  </span>
                  {isCogsReconciled && (
                    <CheckCircle2
                      className="h-3.5 w-3.5 text-emerald-400"
                      aria-label="Schedule C COGS reconciled cent-for-cent"
                    />
                  )}
                </div>
              </div>
            </div>

            {/* KPI Metrics Strip */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:col-span-7">
              <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-950/80 p-3.5">
                <span className="text-[11px] font-medium text-slate-400">
                  Est. Gross FMV
                </span>
                <div>
                  <div className="mt-1 font-mono text-xl font-bold tabular-nums text-slate-100">
                    {formatUsdDisplay(routed.summary.estimatedGrossValueUsd)}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                    {routed.summary.totalCards} cards ({routed.summary.totalLineItems}{" "}
                    SKUs)
                  </div>
                </div>
              </div>

              <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-950/80 p-3.5">
                <span className="text-[11px] font-medium text-slate-400">
                  Est. Net Payout
                </span>
                <div>
                  <div className="mt-1 font-mono text-xl font-bold tabular-nums text-emerald-300">
                    {formatUsdDisplay(routed.summary.estimatedNetPayoutUsd)}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                    {routed.summary.outboundBoxCount} buylist box
                    {routed.summary.outboundBoxCount === 1 ? "" : "es"} (&minus;
                    {formatUsdDisplay(routed.summary.outboundBoxShippingUsd)})
                  </div>
                </div>
              </div>

              <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-950/80 p-3.5">
                <span className="text-[11px] font-medium text-slate-400">
                  Est. Net Profit
                </span>
                <div>
                  <div
                    className={cn(
                      "mt-1 font-mono text-xl font-bold tabular-nums",
                      profitIsNegative ? "text-rose-400" : "text-emerald-400",
                    )}
                  >
                    {formatUsdDisplay(routed.summary.estimatedNetProfitUsd, {
                      signed: true,
                    })}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                    After fees, postage &amp; labor
                  </div>
                </div>
              </div>

              <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-950/80 p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-400">
                    Net ROI
                  </span>
                  <TrendingUp
                    className={cn(
                      "h-3.5 w-3.5",
                      profitIsNegative ? "text-rose-400" : "text-emerald-400",
                    )}
                  />
                </div>
                <div>
                  <div
                    className={cn(
                      "mt-1 font-mono text-xl font-bold tabular-nums",
                      profitIsNegative ? "text-rose-400" : "text-emerald-400",
                    )}
                  >
                    {routed.summary.estimatedNetRoiPct !== null
                      ? `${profitIsNegative ? "" : "+"}${routed.summary.estimatedNetRoiPct}%`
                      : "—"}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                    Buy @{" "}
                    {routed.summary.estimatedGrossValueCents > 0n
                      ? `${Number(
                          (routed.summary.purchaseCostCents * 100n) /
                            routed.summary.estimatedGrossValueCents,
                        )}%`
                      : "0%"}{" "}
                    of FMV
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Scanner CSV Presets & Upload Section */}
        <ScannerIngestPanel
          activePresetId={activePresetId}
          isIngesting={isIngesting}
          diagnostics={diagnostics}
          errorMessage={ingestError}
          onSelectPreset={handleSelectPreset}
          onUploadCsvText={handleUploadCsvText}
        />

        {/* Main Workspace Grid: Left Sliders + Right 4-Pile Table */}
        <div className="grid items-start gap-5 lg:grid-cols-12">
          <div className="lg:col-span-4 xl:col-span-3">
            <RoutingProfileControls
              profile={profile}
              buylistCashMode={buylistCashMode}
              computedLaborPerOrderUsd={computedLaborPerOrderUsd}
              isSavingProfile={isSavingProfile}
              onChangeProfile={handleChangeProfile}
              onChangeBuylistCashMode={setBuylistCashMode}
              onResetDefaults={handleResetDefaults}
              onSaveProfileDefault={handleSaveProfileDefault}
            />
          </div>

          <div className="lg:col-span-8 xl:col-span-9">
            <PilesTable
              items={routed.items}
              summary={routed.summary}
              activeBucketFilter={activeBucketFilter}
              onChangeBucketFilter={setActiveBucketFilter}
            />
          </div>
        </div>
      </main>

      {/* Modals & Drawers */}
      <ExportDrawer
        open={exportDrawerOpen}
        onClose={() => setExportDrawerOpen(false)}
        items={routed.items}
        conduitTier={profile.conduitTierPreference}
        lotName={lotName}
      />

      <SavedLotsDrawer
        open={savedLotsDrawerOpen}
        onClose={() => setSavedLotsDrawerOpen(false)}
        lots={savedLots}
        activeLotId={activeLotId}
        onLoadLot={handleLoadSavedLot}
        onUpdateSettlement={handleUpdateLotSettlement}
        onDeleteLot={handleDeleteLot}
      />
    </div>
  );
}

export { DEMO_SCANNER_PRESETS };
