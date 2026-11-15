"use client";

import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Database,
  Filter,
  Search,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { AssignedBucket } from "@/db/schema";
import {
  formatCentsToUsd,
  parseUsdToCents,
  type RoutedLotItem,
  type RoutedLotSummary,
} from "@/lib/routing";
import { cn } from "@/lib/utils";
import {
  CHANNEL_SHORT_BADGE,
  CONDITION_BADGE_CLASS,
  FINISH_BADGE_CLASS,
  formatChannelName,
  formatUsdDisplay,
  PILE_METADATA,
  QUARANTINE_REASON_LABELS,
} from "./formatters";

type BucketFilter = "ALL" | AssignedBucket | "QUARANTINED" | "DEMOTED";
type SortField =
  | "optimalTotalNet"
  | "optimalUnitNet"
  | "fmv"
  | "costBasis"
  | "name";

interface PilesTableProps {
  items: readonly RoutedLotItem[];
  summary: RoutedLotSummary;
  outboundBuylistBoxShippingUsd: string;
  activeBucketFilter: BucketFilter;
  onChangeBucketFilter: (filter: BucketFilter) => void;
}

export function PilesTable({
  items,
  summary,
  outboundBuylistBoxShippingUsd,
  activeBucketFilter,
  onChangeBucketFilter,
}: PilesTableProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("optimalTotalNet");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const boxPostageLabel = formatUsdDisplay(outboundBuylistBoxShippingUsd);

  const quarantinedCardCount = useMemo(
    () =>
      items
        .filter((i) => i.baselines.isQuarantined)
        .reduce((acc, i) => acc + i.quantity, 0),
    [items],
  );

  const demotedCardCount = useMemo(
    () =>
      items
        .filter((i) => i.demotedFromBuylistByPostageGuard)
        .reduce((acc, i) => acc + i.quantity, 0),
    [items],
  );

  const filteredAndSorted = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const indexed = items.map((item, sourceIndex) => ({ item, sourceIndex }));

    const filtered = indexed.filter(({ item }) => {
      if (activeBucketFilter === "QUARANTINED") {
        if (!item.baselines.isQuarantined) return false;
      } else if (activeBucketFilter === "DEMOTED") {
        if (!item.demotedFromBuylistByPostageGuard) return false;
      } else if (activeBucketFilter !== "ALL") {
        if (item.assignedBucket !== activeBucketFilter) return false;
      }

      if (!q) return true;
      return (
        item.card.name.toLowerCase().includes(q) ||
        item.card.setCode.toLowerCase().includes(q) ||
        item.card.setName.toLowerCase().includes(q) ||
        item.card.collectorNumber.toLowerCase().includes(q) ||
        item.recommendedChannel.toLowerCase().includes(q) ||
        item.condition.toLowerCase().includes(q) ||
        item.finish.toLowerCase().includes(q)
      );
    });

    filtered.sort((lhs, rhs) => {
      const a = lhs.item;
      const b = rhs.item;
      if (sortField === "optimalTotalNet") {
        if (a.totalOptimalNetCents !== b.totalOptimalNetCents) {
          return a.totalOptimalNetCents > b.totalOptimalNetCents ? -1 : 1;
        }
      } else if (sortField === "optimalUnitNet") {
        if (a.optimalUnitNetCents !== b.optimalUnitNetCents) {
          return a.optimalUnitNetCents > b.optimalUnitNetCents ? -1 : 1;
        }
      } else if (sortField === "fmv") {
        const fmvA = BigInt(a.quantity) * a.baselines.initialFmvCents;
        const fmvB = BigInt(b.quantity) * b.baselines.initialFmvCents;
        if (fmvA !== fmvB) return fmvA > fmvB ? -1 : 1;
      } else if (sortField === "costBasis") {
        if (a.allocatedCostBasisCents !== b.allocatedCostBasisCents) {
          return a.allocatedCostBasisCents > b.allocatedCostBasisCents ? -1 : 1;
        }
      }
      const byName = a.card.name.localeCompare(b.card.name);
      if (byName !== 0) return byName;
      return lhs.sourceIndex - rhs.sourceIndex;
    });

    return filtered;
  }, [items, activeBucketFilter, searchQuery, sortField]);

  return (
    <div className="space-y-4">
      {/* 4 Physical Sorting Pile Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            "PILE_1_BUYLIST",
            "PILE_2_SINGLES",
            "PILE_3_CREDIT_ARB",
            "PILE_4_BULK",
          ] as const
        ).map((bucketKey) => {
          const meta = PILE_METADATA[bucketKey];
          const metrics = summary.buckets[bucketKey];
          const isSelected = activeBucketFilter === bucketKey;

          return (
            <button
              key={bucketKey}
              type="button"
              onClick={() =>
                onChangeBucketFilter(isSelected ? "ALL" : bucketKey)
              }
              className={cn(
                "flex flex-col justify-between rounded-2xl border p-4 text-left transition",
                isSelected
                  ? `${meta.accentBorder} bg-slate-900 ring-1 ring-emerald-400/40 shadow-lg`
                  : "border-slate-800/90 bg-slate-900/70 hover:border-slate-700",
              )}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "rounded-md px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider",
                      meta.badgeClass,
                    )}
                  >
                    {meta.pileNumber}
                  </span>
                  <span className="font-mono text-xs text-slate-400">
                    {metrics.lineItemCount} SKUs
                  </span>
                </div>
                <h3 className="mt-2 text-sm font-semibold text-slate-100">
                  {meta.title}
                </h3>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {meta.subtitle}
                </p>
              </div>

              <div className="mt-3.5 flex items-end justify-between border-t border-slate-800/80 pt-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">
                    Physical Cards
                  </div>
                  <div className="font-mono text-xl font-bold tabular-nums text-white">
                    {metrics.totalCards}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">
                    Pile Net Payout
                  </div>
                  <div
                    className={cn(
                      "font-mono text-lg font-bold tabular-nums",
                      meta.accentText,
                    )}
                  >
                    {formatUsdDisplay(metrics.optimalNetUsd)}
                  </div>
                  <div className="font-mono text-[10px] text-slate-500">
                    FMV {formatUsdDisplay(metrics.grossFmvUsd)}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Outbound Buylist Box Viability Banner */}
      {summary.vendorShipments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-slate-800/90 bg-slate-900/60 px-4 py-2.5 text-xs">
          <span className="font-semibold text-slate-200">
            Outbound Wholesale Box Guardrail:
          </span>
          {summary.vendorShipments.map((vs) => (
            <div
              key={vs.vendor}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[11px]",
                vs.demotedToNonBuylist
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
              )}
            >
              {vs.demotedToNonBuylist ? (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                  <span>
                    {vs.vendor === "card_kingdom"
                      ? "Card Kingdom"
                      : "Card Conduit"}{" "}
                    ({vs.totalCards}c · {formatUsdDisplay(vs.grossBuylistNetUsd)}
                    ) AUTO-DEMOTED — failed {boxPostageLabel} box postage hurdle
                    (saved postage!)
                  </span>
                </>
              ) : (
                <span>
                  {vs.vendor === "card_kingdom"
                    ? "Card Kingdom Box"
                    : "Card Conduit Box"}
                  : {vs.totalCards} cards · Gross{" "}
                  {formatUsdDisplay(vs.grossBuylistNetUsd)} &minus;{" "}
                  {formatUsdDisplay(vs.boxShippingUsd)} box ={" "}
                  <strong>
                    {formatUsdDisplay(
                      formatCentsToUsd(
                        (parseUsdToCents(vs.grossBuylistNetUsd) ?? 0n) -
                          (parseUsdToCents(vs.boxShippingUsd) ?? 0n),
                      ),
                    )}
                  </strong>
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Filter Tabs + Search + Sort Bar */}
      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/75 shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-3.5">
          {/* Filter Pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onChangeBucketFilter("ALL")}
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs font-medium transition",
                activeBucketFilter === "ALL"
                  ? "bg-slate-100 text-slate-950"
                  : "bg-slate-950 text-slate-300 hover:bg-slate-800",
              )}
            >
              All ({summary.totalCards})
            </button>
            {(
              [
                "PILE_1_BUYLIST",
                "PILE_2_SINGLES",
                "PILE_3_CREDIT_ARB",
                "PILE_4_BULK",
              ] as const
            ).map((bucket) => (
              <button
                key={bucket}
                type="button"
                onClick={() => onChangeBucketFilter(bucket)}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-xs font-medium transition",
                  activeBucketFilter === bucket
                    ? PILE_METADATA[bucket].badgeClass
                    : "bg-slate-950 text-slate-400 hover:bg-slate-800 hover:text-slate-200",
                )}
              >
                {PILE_METADATA[bucket].shortLabel} (
                {summary.buckets[bucket].totalCards})
              </button>
            ))}

            {quarantinedCardCount > 0 && (
              <button
                type="button"
                onClick={() =>
                  onChangeBucketFilter(
                    activeBucketFilter === "QUARANTINED"
                      ? "ALL"
                      : "QUARANTINED",
                  )
                }
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition",
                  activeBucketFilter === "QUARANTINED"
                    ? "border border-rose-500/50 bg-rose-500/20 text-rose-200"
                    : "bg-slate-950 text-rose-300/80 hover:bg-slate-800",
                )}
              >
                <ShieldAlert className="h-3 w-3" />
                Quarantined ({quarantinedCardCount})
              </button>
            )}

            {demotedCardCount > 0 && (
              <button
                type="button"
                onClick={() =>
                  onChangeBucketFilter(
                    activeBucketFilter === "DEMOTED" ? "ALL" : "DEMOTED",
                  )
                }
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition",
                  activeBucketFilter === "DEMOTED"
                    ? "border border-amber-500/50 bg-amber-500/20 text-amber-200"
                    : "bg-slate-950 text-amber-300/80 hover:bg-slate-800",
                )}
              >
                <AlertTriangle className="h-3 w-3" />
                Box Demoted ({demotedCardCount})
              </button>
            )}
          </div>

          {/* Search & Sort */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search card, set, channel..."
                aria-label="Search routed cards"
                className="w-52 rounded-lg border border-slate-800 bg-slate-950 py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-xs text-slate-400">
              <Filter className="h-3 w-3" />
              <select
                aria-label="Sort routed items"
                value={sortField}
                onChange={(e) => setSortField(e.target.value as SortField)}
                className="bg-transparent text-xs text-slate-200 focus:outline-none"
              >
                <option value="optimalTotalNet" className="bg-slate-900">
                  Sort: Row Net ($)
                </option>
                <option value="optimalUnitNet" className="bg-slate-900">
                  Sort: Unit Net ($)
                </option>
                <option value="fmv" className="bg-slate-900">
                  Sort: Gross FMV ($)
                </option>
                <option value="costBasis" className="bg-slate-900">
                  Sort: Schedule C Basis
                </option>
                <option value="name" className="bg-slate-900">
                  Sort: Card Name
                </option>
              </select>
            </div>
          </div>
        </div>

        {/* High-Density Financial Triage Table */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/70 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                <th className="py-2.5 pl-4 pr-2">Card / Printing</th>
                <th className="px-2 py-2.5 text-right">TCG Net</th>
                <th className="px-2 py-2.5 text-right">Mana Pool</th>
                <th className="px-2 py-2.5 text-right">85% P2P</th>
                <th className="px-2 py-2.5 text-right">CK Cash</th>
                <th className="px-2 py-2.5 text-right">Credit Arb</th>
                <th className="px-2 py-2.5 text-right">Conduit</th>
                <th className="px-2.5 py-2.5">Assigned Pile &amp; Channel</th>
                <th className="px-2.5 py-2.5 text-right">Optimal Net</th>
                <th className="py-2.5 pl-2 pr-4 text-right">Sched C Basis</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
              {filteredAndSorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="py-10 text-center font-sans text-sm text-slate-400"
                  >
                    No cards match the current pile or search filter.
                  </td>
                </tr>
              ) : (
                filteredAndSorted.map(({ item, sourceIndex }) => {
                  const rowKey = `${sourceIndex}-${item.scryfallId}-${item.finish}-${item.condition}-${item.language}`;
                  const isExpanded = expandedKey === rowKey;
                  const pileMeta = PILE_METADATA[item.assignedBucket];
                  const isQuarantined = item.baselines.isQuarantined;
                  const isCascadedBuylist =
                    item.demotedFromBuylistByPostageGuard &&
                    (item.assignedBucket === "PILE_1_BUYLIST" ||
                      item.assignedBucket === "PILE_3_CREDIT_ARB");

                  const winChannel = item.recommendedChannel;

                  return (
                    <Fragment key={rowKey}>
                      <tr
                        onClick={() =>
                          setExpandedKey(isExpanded ? null : rowKey)
                        }
                        className={cn(
                          "cursor-pointer transition-colors hover:bg-slate-800/45",
                          isExpanded && "bg-slate-800/60",
                        )}
                      >
                        {/* Card / Printing / Flags */}
                        <td className="py-2.5 pl-4 pr-2 font-sans">
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 text-slate-500">
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </span>
                            <div>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-200">
                                  {item.quantity}x
                                </span>
                                <span className="font-semibold text-slate-100">
                                  {item.card.name}
                                </span>
                                <span className="font-mono text-[11px] uppercase text-slate-400">
                                  {item.card.setCode} #{item.card.collectorNumber}
                                </span>
                              </div>

                              <div className="mt-1 flex flex-wrap items-center gap-1">
                                <span
                                  className={cn(
                                    "rounded border px-1.5 py-0.2 font-mono text-[10px] font-medium",
                                    CONDITION_BADGE_CLASS[item.condition],
                                  )}
                                >
                                  {item.condition}
                                </span>
                                <span
                                  className={cn(
                                    "rounded border px-1.5 py-0.2 font-mono text-[10px] capitalize",
                                    FINISH_BADGE_CLASS[item.finish],
                                  )}
                                >
                                  {item.finish}
                                </span>
                                {item.language !== "en" && (
                                  <span className="rounded border border-rose-500/40 bg-rose-500/15 px-1.5 py-0.2 font-mono text-[10px] uppercase text-rose-200">
                                    {item.language}
                                  </span>
                                )}
                                {item.isAltered && (
                                  <span className="rounded border border-rose-500/40 bg-rose-500/15 px-1.5 py-0.2 text-[10px] text-rose-200">
                                    Altered
                                  </span>
                                )}
                                {item.isMisprint && (
                                  <span className="rounded border border-rose-500/40 bg-rose-500/15 px-1.5 py-0.2 text-[10px] text-rose-200">
                                    Misprint
                                  </span>
                                )}
                                {isQuarantined && (
                                  <span className="inline-flex items-center gap-0.5 rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.2 text-[10px] font-medium text-rose-300">
                                    <ShieldAlert className="h-2.5 w-2.5" />
                                    Quarantined
                                  </span>
                                )}
                                {item.baselines.usedFreshSkuCache && (
                                  <span className="inline-flex items-center gap-0.5 rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.2 text-[10px] text-sky-300">
                                    <Database className="h-2.5 w-2.5" />
                                    24h SKU Cache
                                  </span>
                                )}
                                {item.demotedFromBuylistByPostageGuard && (
                                  <span className="inline-flex items-center gap-0.5 rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.2 text-[10px] font-medium text-amber-200">
                                    <AlertTriangle className="h-2.5 w-2.5" />
                                    {isCascadedBuylist
                                      ? "Box Guard Cascaded"
                                      : `${boxPostageLabel} Box Demoted`}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Channel Net Columns (Per Copy) */}
                        <td
                          className={cn(
                            "px-2 py-2.5 text-right",
                            winChannel === "tcgplayer_single"
                              ? "font-bold text-sky-300"
                              : "text-slate-400",
                          )}
                        >
                          {formatUsdDisplay(item.nets.netTcgplayerSingleUsd)}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-2.5 text-right",
                            winChannel === "manapool_single"
                              ? "font-bold text-cyan-300"
                              : "text-slate-400",
                          )}
                        >
                          {formatUsdDisplay(item.nets.netManapoolSingleUsd)}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-2.5 text-right",
                            winChannel === "p2p_85_pct"
                              ? "font-bold text-indigo-300"
                              : "text-slate-400",
                          )}
                        >
                          {formatUsdDisplay(item.nets.netP2p85PctUsd)}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-2.5 text-right",
                            isQuarantined
                              ? "text-slate-600 line-through"
                              : winChannel === "ck_cash"
                                ? "font-bold text-emerald-300"
                                : "text-slate-400",
                          )}
                        >
                          {formatUsdDisplay(item.nets.netCkCashUsd)}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-2.5 text-right",
                            isQuarantined
                              ? "text-slate-600 line-through"
                              : winChannel === "ck_credit"
                                ? "font-bold text-violet-300"
                                : "text-slate-400",
                          )}
                        >
                          {formatUsdDisplay(item.nets.netCkCreditUsd)}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-2.5 text-right",
                            isQuarantined
                              ? "text-slate-600 line-through"
                              : winChannel.startsWith("conduit_")
                                ? "font-bold text-teal-300"
                                : "text-slate-400",
                          )}
                        >
                          {formatUsdDisplay(item.nets.netConduitActiveTierUsd)}
                        </td>

                        {/* Assigned Pile & Recommended Channel */}
                        <td className="px-2.5 py-2.5 font-sans">
                          <div className="flex flex-col items-start gap-1">
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold",
                                pileMeta.badgeClass,
                              )}
                            >
                              {pileMeta.shortLabel}
                            </span>
                            <span
                              className={cn(
                                "rounded border px-1.5 py-0.2 text-[10px] font-medium",
                                CHANNEL_SHORT_BADGE[item.recommendedChannel] ??
                                  "border-slate-700 bg-slate-800 text-slate-300",
                              )}
                            >
                              {formatChannelName(item.recommendedChannel)}
                            </span>
                          </div>
                        </td>

                        {/* Optimal Net (Row + Per Unit) */}
                        <td className="px-2.5 py-2.5 text-right">
                          <div className="font-bold text-emerald-300">
                            {formatUsdDisplay(item.totalOptimalNetUsd)}
                          </div>
                          {item.quantity > 1 && (
                            <div className="text-[10px] text-slate-500">
                              {formatUsdDisplay(item.optimalUnitNetUsd)} ea
                            </div>
                          )}
                        </td>

                        {/* IRS Schedule C Cost Basis (Line-item + Unit) */}
                        <td className="py-2.5 pl-2 pr-4 text-right">
                          <div className="font-medium text-slate-200">
                            {formatUsdDisplay(item.allocatedCostBasisUsd)}
                          </div>
                          {item.quantity > 1 && (
                            <div className="text-[10px] text-slate-500">
                              ~{formatUsdDisplay(item.unitAllocatedCostBasisUsd)}{" "}
                              /u
                            </div>
                          )}
                        </td>
                      </tr>

                      {/* Expanded Per-Row Mathematical & Fee Breakdown Inspector */}
                      {isExpanded && (
                        <tr className="bg-slate-950/90 font-sans">
                          <td colSpan={10} className="px-6 py-4">
                            <div className="grid gap-4 lg:grid-cols-3">
                              {/* Column 1: Retail & Wholesale Baselines */}
                              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                                <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                                  <span>
                                    1. Condition-Adjusted Price Baselines
                                  </span>
                                  <span className="font-mono text-[11px] text-slate-400">
                                    FMV: {formatUsdDisplay(item.baselines.initialFmvUsd)}
                                  </span>
                                </div>
                                <dl className="mt-2 space-y-1 font-mono text-[11px]">
                                  <div className="flex justify-between text-slate-300">
                                    <dt className="text-slate-400">
                                      TCGplayer Retail:
                                    </dt>
                                    <dd>
                                      {formatUsdDisplay(
                                        item.baselines.pRetailTcgUsd,
                                      )}
                                    </dd>
                                  </div>
                                  <div className="flex justify-between text-slate-300">
                                    <dt className="text-slate-400">
                                      Mana Pool Retail:
                                    </dt>
                                    <dd>
                                      {formatUsdDisplay(
                                        item.baselines.pRetailMpUsd,
                                      )}
                                    </dd>
                                  </div>
                                  <div className="flex justify-between text-slate-300">
                                    <dt className="text-slate-400">
                                      P2P 85% Claim Price:
                                    </dt>
                                    <dd>
                                      {formatUsdDisplay(
                                        item.baselines.pSaleP2pClaimUsd,
                                      )}{" "}
                                      (of{" "}
                                      {formatUsdDisplay(
                                        item.baselines.pRetailP2pUsd,
                                      )}
                                      )
                                    </dd>
                                  </div>
                                  <div className="flex justify-between text-slate-300">
                                    <dt className="text-slate-400">
                                      CK Cash / Raw Credit:
                                    </dt>
                                    <dd>
                                      {formatUsdDisplay(
                                        item.baselines.pBuyCkUsd,
                                      )}{" "}
                                      /{" "}
                                      {formatUsdDisplay(
                                        item.baselines.ckStoreCreditRawUsd,
                                      )}
                                    </dd>
                                  </div>
                                </dl>
                              </div>

                              {/* Column 2: Fee Drag, Postage & Labor Deductions */}
                              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                                <div className="text-xs font-semibold text-slate-200">
                                  2. Fee, Shipping &amp; Labor Deductions
                                </div>
                                <dl className="mt-2 space-y-1 font-mono text-[11px]">
                                  <div className="flex justify-between text-slate-300">
                                    <dt className="text-slate-400">
                                      Single Packing Labor:
                                    </dt>
                                    <dd>
                                      &minus;
                                      {formatUsdDisplay(item.nets.laborCostUsd)}{" "}
                                      (P2P 0.5&times;)
                                    </dd>
                                  </div>
                                  <div className="flex justify-between text-slate-300">
                                    <dt className="text-slate-400">
                                      Postage (TCG / MP / P2P):
                                    </dt>
                                    <dd>
                                      ${item.nets.shipTcgUsd} / $
                                      {item.nets.shipMpUsd} / $
                                      {item.nets.shipP2pUsd}
                                    </dd>
                                  </div>
                                  <div className="flex justify-between text-slate-300">
                                    <dt className="text-slate-400">
                                      Conduit Sorted / Curated / Std:
                                    </dt>
                                    <dd>
                                      ${item.nets.netConduitSortedUsd} / $
                                      {item.nets.netConduitCuratedUsd} / $
                                      {item.nets.netConduitStandardUsd}
                                    </dd>
                                  </div>
                                  <div className="flex justify-between text-slate-300">
                                    <dt className="text-slate-400">
                                      Best Single vs Cash Buylist:
                                    </dt>
                                    <dd className="text-emerald-300">
                                      {formatUsdDisplay(
                                        item.nets.netBestSingleUsd,
                                      )}{" "}
                                      vs{" "}
                                      {formatUsdDisplay(
                                        item.nets.netBuylistCashUsd,
                                      )}
                                    </dd>
                                  </div>
                                </dl>
                              </div>

                              {/* Column 3: Decision Tree & Schedule C Audit */}
                              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                                  <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                                  <span>
                                    3. Routing Audit &amp; Schedule C COGS
                                  </span>
                                </div>
                                <div className="mt-2 space-y-1.5 text-xs text-slate-300">
                                  {item.baselines.isQuarantined && (
                                    <div className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
                                      Quarantined from buylists:{" "}
                                      {item.baselines.quarantineReasons
                                        .map((r) => QUARANTINE_REASON_LABELS[r])
                                        .join(", ")}
                                    </div>
                                  )}
                                  {item.demotedFromBuylistByPostageGuard && (
                                    <div className="flex flex-wrap items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                                      <span>
                                        {
                                          PILE_METADATA[
                                            item.initialAssignedBucket
                                          ].pileNumber
                                        }{" "}
                                        (
                                        {formatChannelName(
                                          item.initialRecommendedChannel,
                                        )}
                                        )
                                      </span>
                                      <ArrowRight className="h-3 w-3 shrink-0" />
                                      <span>
                                        {
                                          PILE_METADATA[item.assignedBucket]
                                            .pileNumber
                                        }{" "}
                                        (
                                        {formatChannelName(
                                          item.recommendedChannel,
                                        )}
                                        ) · Saved {boxPostageLabel} box postage
                                      </span>
                                    </div>
                                  )}
                                  <div className="font-mono text-[11px] text-slate-400">
                                    Line-Item COGS:{" "}
                                    <strong className="text-slate-100">
                                      {formatUsdDisplay(
                                        item.allocatedCostBasisUsd,
                                      )}
                                    </strong>{" "}
                                    ({item.quantity} &times; ~
                                    {formatUsdDisplay(
                                      item.unitAllocatedCostBasisUsd,
                                    )}
                                    )
                                  </div>
                                  <div className="font-mono text-[11px] text-slate-400">
                                    Est. Line Gross Margin:{" "}
                                    <strong className="text-emerald-300">
                                      {formatUsdDisplay(
                                        formatCentsToUsd(
                                          item.totalOptimalNetCents -
                                            item.allocatedCostBasisCents,
                                        ),
                                      )}
                                    </strong>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
