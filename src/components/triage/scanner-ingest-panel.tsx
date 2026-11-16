"use client";

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FileUp,
  Loader2,
  Sparkles,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import {
  DEMO_SCANNER_PRESETS,
  type DemoScannerPreset,
} from "@/lib/demo/scanner-presets";
import type { TriageDiagnostics } from "@/lib/triage/types";
import { cn } from "@/lib/utils";
import { triggerBrowserDownload } from "./formatters";

interface ScannerIngestPanelProps {
  activePresetId: string | null;
  isIngesting: boolean;
  diagnostics: TriageDiagnostics | null;
  errorMessage: string | null;
  isFullCatalog: boolean;
  catalogCount: number;
  onSelectPreset: (preset: DemoScannerPreset) => Promise<void>;
  onUploadCsvText: (params: {
    csvText: string;
    filename?: string;
  }) => Promise<void>;
  onRequestFullCatalogSync?: () => void;
}

export function ScannerIngestPanel({
  activePresetId,
  isIngesting,
  diagnostics,
  errorMessage,
  isFullCatalog,
  catalogCount,
  onSelectPreset,
  onUploadCsvText,
  onRequestFullCatalogSync,
}: ScannerIngestPanelProps): React.ReactElement {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showRawPaste, setShowRawPaste] = useState(false);
  const [pastedCsv, setPastedCsv] = useState("");

  const handleFileList = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const text = await file.text();
    await onUploadCsvText({ csvText: text, filename: file.name });
  };

  return (
    <section className="rounded-2xl border border-slate-800/90 bg-slate-900/70 p-4 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-slate-100">
            Scanner CSV Presets &amp; Collection Upload
          </h2>
          <span className="hidden rounded-full border border-slate-800 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-400 sm:inline">
            Auto-detects ManaBox · Dragon Shield · TCGplayer App · Delver Lens
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowRawPaste((prev) => !prev)}
            className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-white"
          >
            {showRawPaste ? "Hide Paste CSV" : "Paste Raw CSV/TSV"}
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setIsDragging(false);
              await handleFileList(e.dataTransfer.files);
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition",
              isDragging
                ? "border-emerald-400 bg-emerald-500/20 text-emerald-200"
                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
            )}
          >
            {isIngesting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Drop or Upload CSV / TXT
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={async (e) => {
              await handleFileList(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {/* 4 Scanner Format Preset Cards */}
      <div className="mt-3 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {DEMO_SCANNER_PRESETS.map((preset) => {
          const isSelected = activePresetId === preset.id;
          return (
            <div
              key={preset.id}
              className={cn(
                "group flex flex-col justify-between rounded-xl border p-3 transition",
                isSelected
                  ? "border-emerald-500/60 bg-slate-950 shadow-sm shadow-emerald-950/50"
                  : "border-slate-800/90 bg-slate-950/60 hover:border-slate-700",
              )}
            >
              <div>
                <div className="flex items-center justify-between gap-1.5">
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                    {preset.formatLabel}
                  </span>
                  <span className="text-[10px] font-medium text-slate-400">
                    {preset.badge}
                  </span>
                </div>
                <h3 className="mt-1.5 text-xs font-semibold text-slate-100">
                  {preset.title}
                </h3>
                <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-400">
                  {preset.subtitle}
                </p>
              </div>

              <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-slate-800/80 pt-2">
                <button
                  type="button"
                  disabled={isIngesting}
                  onClick={() => onSelectPreset(preset)}
                  className={cn(
                    "inline-flex flex-1 items-center justify-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition",
                    isSelected
                      ? "bg-emerald-600 text-white"
                      : "bg-slate-800 text-slate-200 hover:bg-slate-700",
                  )}
                >
                  <FileUp className="h-3 w-3" />
                  {isSelected ? "Loaded" : "Load Scan"}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    triggerBrowserDownload(preset.filename, preset.csvText)
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:border-slate-700 hover:text-slate-200"
                  title={`Download sample ${preset.filename}`}
                >
                  <Download className="h-3 w-3" />
                  Sample
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Optional Raw CSV Paste Box */}
      {showRawPaste && (
        <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950 p-3">
          <textarea
            rows={5}
            value={pastedCsv}
            onChange={(e) => setPastedCsv(e.target.value)}
            placeholder="Paste ManaBox, Dragon Shield, TCGplayer App, or Delver Lens CSV/TSV rows (including header row)..."
            className="w-full rounded-lg border border-slate-800 bg-slate-900 p-2.5 font-mono text-xs text-slate-200 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              disabled={isIngesting || pastedCsv.trim() === ""}
              onClick={async () => {
                await onUploadCsvText({
                  csvText: pastedCsv,
                  filename: "pasted-scan.csv",
                });
                setShowRawPaste(false);
              }}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              Resolve &amp; Route Pasted CSV
            </button>
          </div>
        </div>
      )}

      {/* Error Banner */}
      {errorMessage && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Demo-catalog guidance before / after a personal CSV miss */}
      {!isFullCatalog && (
        <div
          role="status"
          className="mt-3 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-100"
        >
          <div className="flex max-w-3xl items-start gap-2">
            <Database className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div>
              <p className="font-semibold text-amber-100">
                Demo catalog only ({catalogCount.toLocaleString("en-US")}{" "}
                printings) — personal ManaBox / Dragon Shield CSVs will resolve
                as <span className="font-mono">catalog_not_found</span> until
                you sync.
              </p>
              <p className="mt-0.5 text-[11px] text-amber-200/85">
                Built-in presets still work. For a real Whole Collection export,
                click <strong>Sync Full 100k+ Catalog</strong> first, then
                re-upload.
              </p>
            </div>
          </div>
          {onRequestFullCatalogSync && (
            <button
              type="button"
              onClick={onRequestFullCatalogSync}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400"
            >
              Sync Full Catalog
            </button>
          )}
        </div>
      )}

      {/* Resolution & 95% Local DB vs 5% Pro SKU Cache Diagnostics Bar */}
      {diagnostics && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800/90 bg-slate-950/80 px-3.5 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Detected{" "}
              <span className="font-mono uppercase">
                {diagnostics.scannerFormat}
              </span>
            </span>
            <span className="text-slate-300">
              Resolved{" "}
              <strong className="font-mono text-white">
                {diagnostics.totalResolvedRows}/{diagnostics.totalParsedRows}
              </strong>{" "}
              SKUs ({diagnostics.totalResolvedCards} total cards)
            </span>
            <span className="text-slate-400">
              Local Catalog Coverage:{" "}
              <strong className="font-mono text-emerald-300">
                {diagnostics.localDbCoveragePct}%
              </strong>{" "}
              ({diagnostics.localDbOnlyCount} local DB ·{" "}
              <span className="text-sky-300">
                {diagnostics.freshSkuCacheHitCount} 24h SKU cache hits
              </span>
              )
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded border border-slate-800 bg-slate-900 px-2 py-0.5 font-mono text-slate-400">
              Pro SKU Eligible Uncached: {diagnostics.proSkuApiEligibleCount}
            </span>
            {diagnostics.unresolvedRowCount > 0 && (
              <span className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 font-medium text-amber-300">
                {diagnostics.unresolvedRowCount} Unresolved
                {diagnostics.catalogNotFoundCount > 0
                  ? ` (${diagnostics.catalogNotFoundCount} catalog_not_found)`
                  : ""}
              </span>
            )}
            {diagnostics.skippedRowCount > 0 && (
              <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-slate-300">
                {diagnostics.skippedRowCount} Skipped (0 qty)
              </span>
            )}
          </div>

          {diagnostics.catalogGuidance && (
            <div
              role="alert"
              className="flex w-full items-start gap-2 border-t border-amber-500/30 pt-2 text-[11px] text-amber-100"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
              <span>{diagnostics.catalogGuidance}</span>
            </div>
          )}

          {diagnostics.unresolvedRows.length > 0 && (
            <div className="w-full border-t border-slate-800 pt-2 text-[11px] text-amber-200/90">
              Unresolved CSV rows:{" "}
              {diagnostics.unresolvedRows
                .slice(0, 4)
                .map(
                  (u) =>
                    `Row ${u.rowNumber} (${u.cardName ?? "Unknown"} [${u.setCode ?? "?"} #${u.collectorNumber ?? "?"}] — ${u.reason})`,
                )
                .join(" · ")}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
