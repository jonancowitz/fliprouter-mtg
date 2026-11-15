"use client";

import {
  AlertCircle,
  Check,
  FolderOpen,
  Loader2,
  Receipt,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import type { CollectionLotStatus } from "@/db/schema";
import type { SavedLotListItem } from "@/lib/triage/types";
import { cn } from "@/lib/utils";
import {
  formatUsdDisplay,
  getLotStatusMeta,
  LOT_STATUS_OPTIONS,
} from "./formatters";

interface SavedLotsDrawerProps {
  open: boolean;
  onClose: () => void;
  lots: readonly SavedLotListItem[];
  activeLotId: string | null;
  onLoadLot: (lotId: string) => Promise<void>;
  onUpdateSettlement: (
    lotId: string,
    patch: {
      status: CollectionLotStatus;
      actualRealizedPayoutUsd: string | null;
    },
  ) => Promise<void>;
  onDeleteLot: (lotId: string) => Promise<void>;
}

export function SavedLotsDrawer({
  open,
  onClose,
  lots,
  activeLotId,
  onLoadLot,
  onUpdateSettlement,
  onDeleteLot,
}: SavedLotsDrawerProps): React.ReactElement | null {
  const [busyLotId, setBusyLotId] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<
    Record<string, CollectionLotStatus>
  >({});
  const [draftRealized, setDraftRealized] = useState<Record<string, string>>(
    {},
  );
  const [savedNoticeId, setSavedNoticeId] = useState<string | null>(null);
  const [errorByLotId, setErrorByLotId] = useState<
    Record<string, string | null>
  >({});

  if (!open) return null;

  const handleSaveRow = async (lot: SavedLotListItem) => {
    setBusyLotId(lot.lotId);
    setErrorByLotId((prev) => ({ ...prev, [lot.lotId]: null }));
    setSavedNoticeId((prev) => (prev === lot.lotId ? null : prev));
    try {
      const status = draftStatus[lot.lotId] ?? lot.status;
      const rawRealized =
        draftRealized[lot.lotId] !== undefined
          ? draftRealized[lot.lotId]!
          : (lot.actualRealizedPayoutUsd ?? "");
      await onUpdateSettlement(lot.lotId, {
        status,
        actualRealizedPayoutUsd:
          rawRealized.trim() === "" ? null : rawRealized.trim(),
      });
      setSavedNoticeId(lot.lotId);
      window.setTimeout(() => {
        setSavedNoticeId((prev) => (prev === lot.lotId ? null : prev));
      }, 1800);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update lot settlement.";
      setErrorByLotId((prev) => ({ ...prev, [lot.lotId]: message }));
    } finally {
      setBusyLotId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/75 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Saved Acquisition Lots & IRS Schedule C Ledger"
    >
      <div className="flex h-full w-full max-w-2xl flex-col border-l border-slate-800 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Receipt className="h-5 w-5 text-emerald-400" />
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Saved Lots &amp; Schedule C COGS Ledger
              </h2>
              <p className="text-xs text-slate-400">
                Persisted in PostgreSQL / PGlite (`collection_lots` +
                cent-reconciled `lot_items`).
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-800 bg-slate-950 p-2 text-slate-400 hover:text-slate-200"
            aria-label="Close saved lots drawer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-6">
          {lots.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-800 bg-slate-950/60 p-8 text-center">
              <p className="text-sm font-medium text-slate-300">
                No saved acquisition lots yet
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Click &ldquo;Save Lot&rdquo; in the top bar to persist the
                current routed lot and proportional FMV Schedule C cost basis.
              </p>
            </div>
          ) : (
            lots.map((lot) => {
              const statusMeta = getLotStatusMeta(
                draftStatus[lot.lotId] ?? lot.status,
              );
              const isActive = activeLotId === lot.lotId;
              const realizedInput =
                draftRealized[lot.lotId] !== undefined
                  ? draftRealized[lot.lotId]!
                  : (lot.actualRealizedPayoutUsd ?? "");
              const rowError = errorByLotId[lot.lotId];

              return (
                <div
                  key={lot.lotId}
                  className={cn(
                    "rounded-xl border p-4 transition",
                    isActive
                      ? "border-emerald-500/50 bg-slate-950"
                      : "border-slate-800 bg-slate-950/70",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-100">
                          {lot.lotName}
                        </span>
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                            statusMeta.badgeClass,
                          )}
                        >
                          {statusMeta.label}
                        </span>
                        {isActive && (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                            Active
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 font-mono text-xs text-slate-400">
                        {lot.purchaseDate} · {lot.totalCards} cards (
                        {lot.lineItemCount} SKUs) · Schedule C Basis Sum:{" "}
                        {formatUsdDisplay(lot.allocatedCostBasisSumUsd)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={busyLotId === lot.lotId}
                        onClick={async () => {
                          setBusyLotId(lot.lotId);
                          setErrorByLotId((prev) => ({
                            ...prev,
                            [lot.lotId]: null,
                          }));
                          try {
                            await onLoadLot(lot.lotId);
                            onClose();
                          } catch (err) {
                            const message =
                              err instanceof Error
                                ? err.message
                                : "Failed to load lot.";
                            setErrorByLotId((prev) => ({
                              ...prev,
                              [lot.lotId]: message,
                            }));
                          } finally {
                            setBusyLotId(null);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-700"
                      >
                        <FolderOpen className="h-3.5 w-3.5 text-emerald-400" />
                        Load Lot
                      </button>
                      <button
                        type="button"
                        disabled={busyLotId === lot.lotId}
                        onClick={async () => {
                          setBusyLotId(lot.lotId);
                          setErrorByLotId((prev) => ({
                            ...prev,
                            [lot.lotId]: null,
                          }));
                          try {
                            await onDeleteLot(lot.lotId);
                          } catch (err) {
                            const message =
                              err instanceof Error
                                ? err.message
                                : "Failed to delete lot.";
                            setErrorByLotId((prev) => ({
                              ...prev,
                              [lot.lotId]: message,
                            }));
                          } finally {
                            setBusyLotId(null);
                          }
                        }}
                        className="rounded-lg border border-slate-800 p-1.5 text-slate-400 hover:border-rose-500/40 hover:text-rose-300"
                        title="Delete saved lot"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Financial summary row */}
                  <div className="mt-3 grid grid-cols-4 gap-2 rounded-lg border border-slate-800/80 bg-slate-900/60 p-2.5 font-mono text-xs tabular-nums">
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">
                        Cost Basis
                      </div>
                      <div className="font-semibold text-slate-200">
                        {formatUsdDisplay(lot.purchaseCostUsd)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">
                        Est. Net
                      </div>
                      <div className="font-semibold text-emerald-300">
                        {formatUsdDisplay(lot.estimatedNetPayoutUsd)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">
                        Realized Payout
                      </div>
                      <div className="font-semibold text-sky-300">
                        {lot.actualRealizedPayoutUsd
                          ? formatUsdDisplay(lot.actualRealizedPayoutUsd)
                          : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-500">
                        Realized P&amp;L
                      </div>
                      <div
                        className={cn(
                          "font-semibold",
                          lot.realizedProfitUsd === null
                            ? "text-slate-500"
                            : lot.realizedProfitUsd.startsWith("-")
                              ? "text-rose-400"
                              : "text-emerald-400",
                        )}
                      >
                        {lot.realizedProfitUsd !== null
                          ? formatUsdDisplay(lot.realizedProfitUsd, {
                              signed: true,
                            })
                          : "Pending"}
                      </div>
                    </div>
                  </div>

                  {/* Inline Status + Realized Settlement Controls */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 pt-1">
                    <select
                      aria-label={`Status for ${lot.lotName}`}
                      value={draftStatus[lot.lotId] ?? lot.status}
                      onChange={(e) =>
                        setDraftStatus((prev) => ({
                          ...prev,
                          [lot.lotId]: e.target.value as CollectionLotStatus,
                        }))
                      }
                      className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
                    >
                      {LOT_STATUS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>

                    <div className="relative flex items-center">
                      <span className="pointer-events-none absolute left-2.5 font-mono text-xs text-slate-400">
                        $
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="Realized Payout (USD)"
                        aria-label={`Realized payout for ${lot.lotName}`}
                        value={realizedInput}
                        onChange={(e) => {
                          setErrorByLotId((prev) => ({
                            ...prev,
                            [lot.lotId]: null,
                          }));
                          setDraftRealized((prev) => ({
                            ...prev,
                            [lot.lotId]: e.target.value,
                          }));
                        }}
                        className="w-44 rounded-lg border border-slate-700 bg-slate-900 py-1.5 pl-6 pr-2.5 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
                      />
                    </div>

                    <button
                      type="button"
                      disabled={busyLotId === lot.lotId}
                      onClick={() => handleSaveRow(lot)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {busyLotId === lot.lotId ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : savedNoticeId === lot.lotId ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : null}
                      {savedNoticeId === lot.lotId
                        ? "Updated"
                        : "Update Settlement"}
                    </button>
                  </div>

                  {rowError && (
                    <div
                      role="alert"
                      className="mt-2.5 flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200"
                    >
                      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                      <span>{rowError}</span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
