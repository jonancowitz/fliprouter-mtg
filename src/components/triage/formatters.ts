import type {
  AssignedBucket,
  CardCondition,
  CardFinish,
  CollectionLotStatus,
  RecommendedChannel,
} from "@/db/schema";
import type { QuarantineReason } from "@/lib/routing";

export interface PileMeta {
  bucket: AssignedBucket;
  shortLabel: string;
  pileNumber: string;
  title: string;
  subtitle: string;
  accentBorder: string;
  accentBg: string;
  accentText: string;
  badgeClass: string;
}

export const PILE_METADATA: Record<AssignedBucket, PileMeta> = {
  PILE_1_BUYLIST: {
    bucket: "PILE_1_BUYLIST",
    shortLabel: "Pile 1 · Cash Buylist",
    pileNumber: "PILE 1",
    title: "Wholesale Cash Buylist",
    subtitle: "Zero-labor CK Cash / Card Conduit box",
    accentBorder: "border-emerald-500/40",
    accentBg: "bg-emerald-500/10",
    accentText: "text-emerald-300",
    badgeClass:
      "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
  },
  PILE_2_SINGLES: {
    bucket: "PILE_2_SINGLES",
    shortLabel: "Pile 2 · Singles & P2P",
    pileNumber: "PILE 2",
    title: "High-Margin Singles & P2P",
    subtitle: "TCGplayer, Mana Pool & 85% FB/Discord Claims",
    accentBorder: "border-sky-500/40",
    accentBg: "bg-sky-500/10",
    accentText: "text-sky-300",
    badgeClass: "bg-sky-500/15 text-sky-300 border border-sky-500/30",
  },
  PILE_3_CREDIT_ARB: {
    bucket: "PILE_3_CREDIT_ARB",
    shortLabel: "Pile 3 · Credit Arb",
    pileNumber: "PILE 3",
    title: "Store-Credit Arbitrage",
    subtitle: "CK +30% Credit × 0.82 (1.066× cash up-trade)",
    accentBorder: "border-violet-500/40",
    accentBg: "bg-violet-500/10",
    accentText: "text-violet-300",
    badgeClass:
      "bg-violet-500/15 text-violet-300 border border-violet-500/30",
  },
  PILE_4_BULK: {
    bucket: "PILE_4_BULK",
    shortLabel: "Pile 4 · Quarantine & Bulk",
    pileNumber: "PILE 4",
    title: "Quarantine & Bulk Guardrail",
    subtitle: "$0.50–$1.49 local binder & $3/1k wholesale bulk",
    accentBorder: "border-amber-500/35",
    accentBg: "bg-amber-500/10",
    accentText: "text-amber-300",
    badgeClass: "bg-slate-800 text-slate-300 border border-slate-700",
  },
};

export const CHANNEL_LABELS: Record<string, string> = {
  tcgplayer_single: "TCGplayer Single",
  manapool_single: "Mana Pool Single",
  p2p_85_pct: "85% TCG Low P2P",
  ck_cash: "CK Cash Buylist",
  ck_credit: "CK Credit (1.066×)",
  conduit_sorted: "Conduit Sorted (2%)",
  conduit_curated: "Conduit Curated (5%)",
  conduit_standard: "Conduit Standard (10%)",
  binder_local: "$0.50/$1 Local Binder",
  bulk_wholesale: "$3/1k Bulk Box",
};

export const CHANNEL_SHORT_BADGE: Record<string, string> = {
  tcgplayer_single: "bg-sky-500/15 text-sky-200 border-sky-500/30",
  manapool_single: "bg-cyan-500/15 text-cyan-200 border-cyan-500/30",
  p2p_85_pct: "bg-indigo-500/15 text-indigo-200 border-indigo-500/30",
  ck_cash: "bg-emerald-500/15 text-emerald-200 border-emerald-500/30",
  ck_credit: "bg-violet-500/15 text-violet-200 border-violet-500/30",
  conduit_sorted: "bg-teal-500/15 text-teal-200 border-teal-500/30",
  conduit_curated: "bg-teal-500/15 text-teal-200 border-teal-500/30",
  conduit_standard: "bg-teal-500/15 text-teal-200 border-teal-500/30",
  binder_local: "bg-amber-500/15 text-amber-200 border-amber-500/30",
  bulk_wholesale: "bg-slate-800 text-slate-300 border-slate-700",
};

export const QUARANTINE_REASON_LABELS: Record<QuarantineReason, string> = {
  damaged_condition: "Damaged (DMG)",
  non_english_language: "Foreign / Non-EN",
  altered_card: "Altered / Signed",
  misprint_card: "Misprint",
};

export const CONDITION_BADGE_CLASS: Record<CardCondition, string> = {
  NM: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  LP: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  MP: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  HP: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  DMG: "bg-rose-500/20 text-rose-300 border-rose-500/40",
};

export const FINISH_BADGE_CLASS: Record<CardFinish, string> = {
  normal: "bg-slate-800/90 text-slate-300 border-slate-700",
  foil: "bg-amber-500/15 text-amber-200 border-amber-400/35",
  etched: "bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-400/35",
};

export const LOT_STATUS_OPTIONS: ReadonlyArray<{
  value: CollectionLotStatus;
  label: string;
  badgeClass: string;
}> = [
  {
    value: "triaged",
    label: "Triaged",
    badgeClass: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  },
  {
    value: "exported",
    label: "Exported",
    badgeClass: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  },
  {
    value: "shipped",
    label: "Shipped",
    badgeClass: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  {
    value: "partially_settled",
    label: "Partially Settled",
    badgeClass: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  },
  {
    value: "settled",
    label: "Settled (1099/Sched C)",
    badgeClass: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  },
  {
    value: "routed",
    label: "Routed",
    badgeClass: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  },
  {
    value: "draft",
    label: "Draft",
    badgeClass: "bg-slate-800 text-slate-300 border-slate-700",
  },
];

export function getLotStatusMeta(status: CollectionLotStatus): {
  value: CollectionLotStatus;
  label: string;
  badgeClass: string;
} {
  return (
    LOT_STATUS_OPTIONS.find((opt) => opt.value === status) ??
    LOT_STATUS_OPTIONS[0]!
  );
}

export function formatUsdDisplay(
  usd: string | null | undefined,
  options: { signed?: boolean } = {},
): string {
  if (usd === null || usd === undefined || usd === "") {
    return "$0.00";
  }
  const trimmed = usd.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", frac = "00"] = body.split(".");
  const formattedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (negative) {
    return `-$${formattedWhole}.${frac}`;
  }
  if (options.signed && body !== "0.00") {
    return `+$${formattedWhole}.${frac}`;
  }
  return `$${formattedWhole}.${frac}`;
}

export function formatChannelName(channel: RecommendedChannel): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

export function triggerBrowserDownload(
  filename: string,
  content: string,
  mimeType = "text/csv;charset=utf-8",
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
