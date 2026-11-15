"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileSpreadsheet,
  MessageSquareText,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ConduitTierPreference } from "@/db/schema";
import {
  type CardConduitBatchFile,
  type CardConduitExportResult,
  type CardKingdomExportMode,
  exportCardKingdomBuylistCsv,
  exportP2pClaimMarkdown,
  generateAllLotExports,
} from "@/lib/csv/exports";
import type { RoutedLotItem } from "@/lib/routing";
import { cn } from "@/lib/utils";
import { formatUsdDisplay, triggerBrowserDownload } from "./formatters";

interface ExportDrawerProps {
  open: boolean;
  onClose: () => void;
  items: readonly RoutedLotItem[];
  conduitTier: ConduitTierPreference;
  lotName: string;
}

type ActivePreviewTab =
  | "p2p_markdown"
  | "card_kingdom"
  | "card_conduit"
  | "tcgplayer"
  | "manapool";

export interface ConduitDrawerViewState {
  readonly safeBatchIdx: number;
  readonly activeBatch: CardConduitBatchFile | undefined;
  readonly previewFilename: string;
  readonly previewContent: string;
  readonly downloadDisabled: boolean;
  readonly primaryDownloadFiles: ReadonlyArray<{
    readonly filename: string;
    readonly csv: string;
  }>;
}

export function resolveConduitDrawerView(
  conduitExport: CardConduitExportResult,
  requestedBatchIdx: number,
): ConduitDrawerViewState {
  const safeBatchIdx = Math.min(
    Math.max(0, requestedBatchIdx),
    Math.max(0, conduitExport.batches.length - 1),
  );
  const activeBatch = conduitExport.batches[safeBatchIdx];
  const downloadDisabled =
    conduitExport.totalCards === 0 || !conduitExport.validation.valid;

  const primaryDownloadFiles = downloadDisabled
    ? []
    : conduitExport.batches.map((batch) => ({
        filename: batch.filename,
        csv: batch.csv,
      }));

  return {
    safeBatchIdx,
    activeBatch,
    previewFilename:
      activeBatch?.filename ?? `card-conduit-${conduitExport.tier}.csv`,
    previewContent: activeBatch?.csv ?? conduitExport.csv,
    downloadDisabled,
    primaryDownloadFiles,
  };
}

export function ExportDrawer({
  open,
  onClose,
  items,
  conduitTier,
  lotName,
}: ExportDrawerProps): React.ReactElement | null {
  const [ckHeaderStyle, setCkHeaderStyle] = useState<"spec" | "ck_title">(
    "spec",
  );
  const [ckMode, setCkMode] = useState<CardKingdomExportMode>("all");
  const [p2pIncludeAllSingles, setP2pIncludeAllSingles] = useState(false);
  const [conduitBatchIdx, setConduitBatchIdx] = useState(0);
  const [activePreview, setActivePreview] =
    useState<ActivePreviewTab>("p2p_markdown");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const bundle = useMemo(
    () =>
      generateAllLotExports(items, {
        conduitTier,
        strictConduitValidation: false,
      }),
    [items, conduitTier],
  );

  const ckExport = useMemo(
    () =>
      exportCardKingdomBuylistCsv(items, {
        mode: ckMode,
        headerStyle: ckHeaderStyle,
      }),
    [items, ckMode, ckHeaderStyle],
  );

  const p2pExport = useMemo(
    () =>
      exportP2pClaimMarkdown(items, {
        includeAllSingles: p2pIncludeAllSingles,
        title: `## ${lotName || "MTG Claim Sale"} — 85% TCG Low (PayPal G&S)`,
      }),
    [items, p2pIncludeAllSingles, lotName],
  );

  if (!open) return null;

  const conduitView = resolveConduitDrawerView(
    bundle.cardConduit,
    conduitBatchIdx,
  );
  const safeConduitBatchIdx = conduitView.safeBatchIdx;
  const conduitDownloadDisabled = conduitView.downloadDisabled;

  const handleDownloadConduitPrimary = () => {
    for (const file of conduitView.primaryDownloadFiles) {
      triggerBrowserDownload(file.filename, file.csv);
    }
  };

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 2000);
    } catch {
      // Clipboard fallback
    }
  };

  const previewContent =
    activePreview === "p2p_markdown"
      ? p2pExport.markdown
      : activePreview === "card_kingdom"
        ? ckExport.csv
        : activePreview === "card_conduit"
          ? conduitView.previewContent
          : activePreview === "tcgplayer"
            ? bundle.tcgplayerStaged.csv
            : bundle.manapoolStaged.csv;

  const previewFilename =
    activePreview === "p2p_markdown"
      ? p2pExport.filename
      : activePreview === "card_kingdom"
        ? ckExport.filename
        : activePreview === "card_conduit"
          ? conduitView.previewFilename
          : activePreview === "tcgplayer"
            ? bundle.tcgplayerStaged.filename
            : bundle.manapoolStaged.filename;

  const previewDownloadDisabled =
    (activePreview === "card_conduit" && conduitDownloadDisabled) ||
    (activePreview === "card_kingdom" && ckExport.totalCards === 0) ||
    (activePreview === "tcgplayer" && bundle.tcgplayerStaged.totalCards === 0) ||
    (activePreview === "manapool" && bundle.manapoolStaged.totalCards === 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Platform Manifest Exports"
    >
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">
              1-Click Liquidation Manifest Exports
            </h2>
            <p className="text-xs text-slate-400">
              RFC-4180 escaped &amp; OWASP formula-injection sanitized manifests
              ready for vendor upload or Discord/FB claim posting.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-800 bg-slate-950 p-2 text-slate-400 hover:border-slate-700 hover:text-slate-200"
            aria-label="Close export modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid flex-1 gap-5 overflow-y-auto p-6 lg:grid-cols-12">
          {/* Left column: 5 Manifest Export Cards */}
          <div className="space-y-3 lg:col-span-6">
            {/* 1. Card Conduit CSV */}
            <div
              className={cn(
                "rounded-xl border p-3.5 transition",
                activePreview === "card_conduit"
                  ? "border-emerald-500/50 bg-slate-950"
                  : "border-slate-800 bg-slate-950/60 hover:border-slate-700",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-teal-400" />
                    <span className="text-sm font-semibold text-slate-100">
                      1. Card Conduit ({conduitTier.toUpperCase()})
                    </span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                      {bundle.cardConduit.totalCards} cards
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs">
                    {bundle.cardConduit.validation.valid ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                        <span className="text-emerald-300">
                          {bundle.cardConduit.validation.eligiblePercentage}%
                          eligible (&ge;$0.50 buylist; req{" "}
                          {bundle.cardConduit.validation.requiredPercentage}%)
                        </span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                        <span className="text-amber-300">
                          {bundle.cardConduit.validation.errorMessage}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setActivePreview("card_conduit")}
                    className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800"
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    disabled={conduitDownloadDisabled}
                    onClick={handleDownloadConduitPrimary}
                    title={
                      !bundle.cardConduit.validation.valid
                        ? bundle.cardConduit.validation.errorMessage
                        : bundle.cardConduit.batches.length > 1
                          ? `Download all ${bundle.cardConduit.batches.length} split <=500-card batch CSVs`
                          : "Download Card Conduit CSV"
                    }
                    className="inline-flex items-center gap-1 rounded-md bg-teal-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {bundle.cardConduit.batches.length > 1
                      ? `All (${bundle.cardConduit.batches.length})`
                      : "CSV"}
                  </button>
                </div>
              </div>
              {bundle.cardConduit.batches.length > 1 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-slate-800 pt-2">
                  {bundle.cardConduit.batches.map((batch, idx) => {
                    const isFocused =
                      activePreview === "card_conduit" &&
                      safeConduitBatchIdx === idx;
                    return (
                      <div
                        key={batch.batchNumber}
                        className={cn(
                          "inline-flex items-center overflow-hidden rounded border text-[11px]",
                          isFocused
                            ? "border-teal-400 bg-teal-500/20 text-teal-100"
                            : "border-teal-500/30 bg-teal-500/10 text-teal-200",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setActivePreview("card_conduit");
                            setConduitBatchIdx(idx);
                          }}
                          className="px-2 py-0.5 hover:bg-teal-500/20"
                        >
                          Batch #{batch.batchNumber} ({batch.totalCards} cards)
                        </button>
                        <button
                          type="button"
                          disabled={!bundle.cardConduit.validation.valid}
                          onClick={() =>
                            triggerBrowserDownload(batch.filename, batch.csv)
                          }
                          className="border-l border-teal-500/30 px-1.5 py-0.5 hover:bg-teal-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                          title={`Download ${batch.filename}`}
                          aria-label={`Download ${batch.filename}`}
                        >
                          <Download className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 2. Card Kingdom Buylist CSV */}
            <div
              className={cn(
                "rounded-xl border p-3.5 transition",
                activePreview === "card_kingdom"
                  ? "border-emerald-500/50 bg-slate-950"
                  : "border-slate-800 bg-slate-950/60 hover:border-slate-700",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-emerald-400" />
                    <span className="text-sm font-semibold text-slate-100">
                      2. Card Kingdom Buylist CSV
                    </span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                      {ckExport.totalCards} cards ({ckExport.rowCount} rows)
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Pile 1 Cash ({bundle.cardKingdomCash.totalCards}) + Pile 3
                    Credit Arb ({bundle.cardKingdomCredit.totalCards})
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setActivePreview("card_kingdom")}
                    className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800"
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    disabled={ckExport.totalCards === 0}
                    onClick={() =>
                      triggerBrowserDownload(ckExport.filename, ckExport.csv)
                    }
                    className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Download className="h-3.5 w-3.5" />
                    CSV
                  </button>
                </div>
              </div>
              {/* CK Header & Mode Controls */}
              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-2.5 text-xs">
                <div className="flex items-center gap-1">
                  <span className="text-slate-400">Header:</span>
                  <button
                    type="button"
                    onClick={() => setCkHeaderStyle("spec")}
                    className={cn(
                      "rounded px-2 py-0.5 font-mono text-[11px]",
                      ckHeaderStyle === "spec"
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                        : "bg-slate-800 text-slate-400 hover:text-slate-200",
                    )}
                  >
                    Card Name
                  </button>
                  <button
                    type="button"
                    onClick={() => setCkHeaderStyle("ck_title")}
                    className={cn(
                      "rounded px-2 py-0.5 font-mono text-[11px]",
                      ckHeaderStyle === "ck_title"
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                        : "bg-slate-800 text-slate-400 hover:text-slate-200",
                    )}
                  >
                    Title
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  {(["all", "cash", "credit"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setCkMode(mode)}
                      className={cn(
                        "rounded px-2 py-0.5 text-[11px] capitalize",
                        ckMode === mode
                          ? "bg-slate-700 text-white font-medium"
                          : "bg-slate-800/60 text-slate-400 hover:text-slate-200",
                      )}
                    >
                      {mode === "all" ? "Combined" : mode}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 3. TCGplayer Staged Inventory CSV */}
            <div
              className={cn(
                "rounded-xl border p-3.5 transition",
                activePreview === "tcgplayer"
                  ? "border-sky-500/50 bg-slate-950"
                  : "border-slate-800 bg-slate-950/60 hover:border-slate-700",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-sky-400" />
                    <span className="text-sm font-semibold text-slate-100">
                      3. TCGplayer Staged Inventory CSV
                    </span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                      {bundle.tcgplayerStaged.totalCards} cards
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">
                    18-column seller portal import (`Add to Quantity` &amp;
                    condition-adjusted market price).
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setActivePreview("tcgplayer")}
                    className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800"
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    disabled={bundle.tcgplayerStaged.totalCards === 0}
                    onClick={() =>
                      triggerBrowserDownload(
                        bundle.tcgplayerStaged.filename,
                        bundle.tcgplayerStaged.csv,
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Download className="h-3.5 w-3.5" />
                    CSV
                  </button>
                </div>
              </div>
            </div>

            {/* 4. Mana Pool Staged Singles CSV */}
            <div
              className={cn(
                "rounded-xl border p-3.5 transition",
                activePreview === "manapool"
                  ? "border-cyan-500/50 bg-slate-950"
                  : "border-slate-800 bg-slate-950/60 hover:border-slate-700",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-cyan-400" />
                    <span className="text-sm font-semibold text-slate-100">
                      4. Mana Pool Staged Singles CSV
                    </span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                      {bundle.manapoolStaged.totalCards} cards
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Scryfall UUID + finish/condition/language keyed 5% fee
                    singles feed.
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setActivePreview("manapool")}
                    className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800"
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    disabled={bundle.manapoolStaged.totalCards === 0}
                    onClick={() =>
                      triggerBrowserDownload(
                        bundle.manapoolStaged.filename,
                        bundle.manapoolStaged.csv,
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-md bg-cyan-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Download className="h-3.5 w-3.5" />
                    CSV
                  </button>
                </div>
              </div>
            </div>

            {/* 5. Discord / FB 85% TCG Low Claim Post */}
            <div
              className={cn(
                "rounded-xl border p-3.5 transition",
                activePreview === "p2p_markdown"
                  ? "border-indigo-500/50 bg-slate-950"
                  : "border-slate-800 bg-slate-950/60 hover:border-slate-700",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <MessageSquareText className="h-4 w-4 text-indigo-400" />
                    <span className="text-sm font-semibold text-slate-100">
                      5. Discord / FB &ldquo;85% TCG Low&rdquo; Claim Post
                    </span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                      {p2pExport.totalCards} cards
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Sum of 85% Claims:{" "}
                    <span className="font-mono font-medium text-indigo-300">
                      {formatUsdDisplay(p2pExport.totalClaimValueUsd)}
                    </span>{" "}
                    (TCG Low Ref:{" "}
                    {formatUsdDisplay(p2pExport.totalRetailReferenceUsd)})
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setActivePreview("p2p_markdown")}
                    className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800"
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => copyText("p2p_md", p2pExport.markdown)}
                    className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500"
                  >
                    {copiedKey === "p2p_md" ? (
                      <>
                        <Check className="h-3.5 w-3.5" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        Copy Post
                      </>
                    )}
                  </button>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-slate-800/80 pt-2 text-xs text-slate-400">
                <label className="inline-flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={p2pIncludeAllSingles}
                    onChange={(e) => setP2pIncludeAllSingles(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-indigo-500"
                  />
                  <span>Include all Pile 2 singles in claim post</span>
                </label>
                <button
                  type="button"
                  onClick={() =>
                    triggerBrowserDownload(
                      p2pExport.filename,
                      p2pExport.markdown,
                      "text/markdown;charset=utf-8",
                    )
                  }
                  className="text-indigo-300 hover:underline"
                >
                  Download .md
                </button>
              </div>
            </div>
          </div>

          {/* Right column: Live Manifest / Claim Post Preview */}
          <div className="flex flex-col rounded-xl border border-slate-800 bg-slate-950 lg:col-span-6">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium text-slate-200">
                  {previewFilename}
                </span>
                {activePreview === "card_conduit" &&
                  bundle.cardConduit.batches.length > 1 && (
                    <div className="flex items-center gap-1">
                      {bundle.cardConduit.batches.map((batch, idx) => (
                        <button
                          key={batch.batchNumber}
                          type="button"
                          onClick={() => setConduitBatchIdx(idx)}
                          className={cn(
                            "rounded px-1.5 py-0.5 font-mono text-[10px]",
                            safeConduitBatchIdx === idx
                              ? "bg-teal-500/20 text-teal-200 border border-teal-500/40"
                              : "bg-slate-900 text-slate-400 hover:text-slate-200",
                          )}
                        >
                          #{batch.batchNumber} ({batch.totalCards})
                        </button>
                      ))}
                    </div>
                  )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={
                    activePreview === "card_conduit" &&
                    !bundle.cardConduit.validation.valid
                  }
                  onClick={() => copyText("preview", previewContent)}
                  className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {copiedKey === "preview" ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      Copy Raw
                    </>
                  )}
                </button>
                <button
                  type="button"
                  disabled={previewDownloadDisabled}
                  onClick={() =>
                    triggerBrowserDownload(
                      previewFilename,
                      previewContent,
                      activePreview === "p2p_markdown"
                        ? "text/markdown;charset=utf-8"
                        : "text/csv;charset=utf-8",
                    )
                  }
                  className="inline-flex items-center gap-1 rounded bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-100 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </button>
              </div>
            </div>
            {activePreview === "card_conduit" &&
              !bundle.cardConduit.validation.valid && (
                <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span>
                    Export blocked: {bundle.cardConduit.validation.errorMessage}{" "}
                    Switch Card Conduit tier to Standard or remove sub-$0.50
                    cards.
                  </span>
                </div>
              )}
            <pre className="max-h-[470px] flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-slate-300">
              {previewContent}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
