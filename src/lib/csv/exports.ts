import type {
  AssignedBucket,
  CardCondition,
  CardFinish,
  ConduitTierPreference,
  RecommendedChannel,
} from "@/db/schema";
import {
  divRoundHalfUp,
  formatBasisPointsToPercent,
  formatCentsToUsd,
  mulCentsByRatioHalfUp,
  parseRequiredUsdToCents,
} from "@/lib/routing/money";
import type { CatalogPriceFields, RoutedLotItem } from "@/lib/routing/types";

export type ExportableLotItem = Pick<
  RoutedLotItem,
  | "card"
  | "finish"
  | "condition"
  | "language"
  | "isAltered"
  | "isMisprint"
  | "quantity"
  | "assignedBucket"
  | "recommendedChannel"
> & {
  baselines: Pick<
    RoutedLotItem["baselines"],
    | "pRetailTcgUsd"
    | "pRetailMpUsd"
    | "pRetailP2pUsd"
    | "pSaleP2pClaimUsd"
    | "pBuyCkCents"
    | "pBuyConduitCents"
  >;
};

export const CARD_CONDUIT_HEADERS = [
  "Quantity",
  "Name",
  "Set Code",
  "Collector Number",
  "Finish",
  "Condition",
  "Scryfall ID",
] as const;

export const CARD_KINGDOM_BUYLIST_SPEC_HEADERS = [
  "Card Name",
  "Edition",
  "Foil",
  "Quantity",
] as const;

export const CARD_KINGDOM_BUYLIST_TITLE_HEADERS = [
  "Title",
  "Edition",
  "Foil",
  "Quantity",
] as const;

export const TCGPLAYER_STAGED_HEADERS = [
  "TCGplayer Id",
  "Product Line",
  "Set Name",
  "Product Name",
  "Title",
  "Number",
  "Rarity",
  "Condition",
  "TCG Market Price",
  "TCG Direct Low",
  "TCG Low Price With Shipping",
  "TCG Low Price",
  "Total Quantity",
  "Add to Quantity",
  "TCG Marketplace Price",
  "My Store Reserve Quantity",
  "My Store Price",
  "Photo URL",
] as const;

export const MANAPOOL_STAGED_HEADERS = [
  "Scryfall ID",
  "TCGplayer ID",
  "Set Code",
  "Collector Number",
  "Name",
  "Finish",
  "Condition",
  "Language",
  "Quantity",
  "Price USD",
] as const;

const BUYLIST_FIFTY_CENT_THRESHOLD = 50n;
const DEFAULT_CONDUIT_SORTED_MAX_CARDS = 500;

export class CardConduitValidationError extends Error {
  readonly tier: ConduitTierPreference;
  readonly totalCards: number;
  readonly eligibleCards: number;
  readonly eligiblePercentage: string;

  constructor(params: {
    message: string;
    tier: ConduitTierPreference;
    totalCards: number;
    eligibleCards: number;
    eligiblePercentage: string;
  }) {
    super(params.message);
    this.name = "CardConduitValidationError";
    this.tier = params.tier;
    this.totalCards = params.totalCards;
    this.eligibleCards = params.eligibleCards;
    this.eligiblePercentage = params.eligiblePercentage;
  }
}

export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function serializeCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
  lineEnding: "\n" | "\r\n" = "\n",
): string {
  const lines: string[] = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(","));
  }
  return lines.join(lineEnding);
}

export interface CardConduitShipmentValidation {
  readonly valid: boolean;
  readonly tier: ConduitTierPreference;
  readonly totalCards: number;
  readonly eligibleCards: number;
  readonly eligiblePercentage: string;
  readonly requiredPercentage: string;
  readonly errorMessage?: string;
}

export interface CardConduitBatchFile {
  readonly batchNumber: number;
  readonly filename: string;
  readonly rowCount: number;
  readonly totalCards: number;
  readonly csv: string;
}

export interface CardConduitExportResult {
  readonly tier: ConduitTierPreference;
  readonly validation: CardConduitShipmentValidation;
  readonly totalCards: number;
  readonly batches: CardConduitBatchFile[];
  /** Single combined CSV (or first batch when `batches.length === 1`; header-only when empty). */
  readonly csv: string;
}

export interface CardConduitExportOptions {
  readonly tier?: ConduitTierPreference;
  readonly validate?: boolean;
  readonly maxCardsPerSortedBatch?: number;
  readonly strictChannelMatch?: boolean;
  readonly includeCkCashRows?: boolean;
}

function getEffectiveConduitPBuyCents(item: ExportableLotItem): bigint {
  return item.baselines.pBuyConduitCents > 0n
    ? item.baselines.pBuyConduitCents
    : item.baselines.pBuyCkCents;
}

function filterConduitItems(
  items: readonly ExportableLotItem[],
  options: CardConduitExportOptions,
): ExportableLotItem[] {
  const pile1 = items.filter((item) => item.assignedBucket === "PILE_1_BUYLIST");
  if (options.strictChannelMatch) {
    return pile1.filter((item) =>
      item.recommendedChannel.startsWith("conduit_"),
    );
  }
  if (options.includeCkCashRows) {
    return pile1;
  }
  const hasExplicitConduit = pile1.some((item) =>
    item.recommendedChannel.startsWith("conduit_"),
  );
  const hasExplicitCk = pile1.some(
    (item) => item.recommendedChannel === "ck_cash",
  );
  if (hasExplicitConduit && hasExplicitCk) {
    return pile1.filter((item) =>
      item.recommendedChannel.startsWith("conduit_"),
    );
  }
  return pile1;
}

export function validateCardConduitShipment(
  items: readonly ExportableLotItem[],
  tier: ConduitTierPreference = "curated",
): CardConduitShipmentValidation {
  let totalCards = 0;
  let eligibleCards = 0;

  for (const item of items) {
    totalCards += item.quantity;
    if (getEffectiveConduitPBuyCents(item) >= BUYLIST_FIFTY_CENT_THRESHOLD) {
      eligibleCards += item.quantity;
    }
  }

  const eligiblePctBps =
    totalCards > 0
      ? divRoundHalfUp(BigInt(eligibleCards) * 10_000n, BigInt(totalCards))
      : 10_000n;
  const eligiblePercentage = formatBasisPointsToPercent(eligiblePctBps);

  if (totalCards === 0 || tier === "standard") {
    return {
      valid: true,
      tier,
      totalCards,
      eligibleCards,
      eligiblePercentage,
      requiredPercentage: "0.00",
    };
  }

  if (tier === "sorted") {
    const valid = eligibleCards === totalCards;
    return {
      valid,
      tier,
      totalCards,
      eligibleCards,
      eligiblePercentage,
      requiredPercentage: "100.00",
      errorMessage: valid
        ? undefined
        : `Card Conduit Sorted requires 100% of cards to have P_buy >= $0.50 (got ${eligibleCards}/${totalCards} = ${eligiblePercentage}%).`,
    };
  }

  // tier === "curated": >= 90% of total quantity must have P_buy >= $0.50
  const valid = BigInt(eligibleCards) * 100n >= BigInt(totalCards) * 90n;
  return {
    valid,
    tier,
    totalCards,
    eligibleCards,
    eligiblePercentage,
    requiredPercentage: "90.00",
    errorMessage: valid
      ? undefined
      : `Card Conduit Curated requires at least 90% of total card quantity to have P_buy >= $0.50 (got ${eligibleCards}/${totalCards} = ${eligiblePercentage}%).`,
  };
}

function toConduitCsvRow(
  item: ExportableLotItem,
  quantityOverride?: number,
): Array<string | number> {
  return [
    quantityOverride ?? item.quantity,
    item.card.name,
    item.card.setCode.toUpperCase(),
    item.card.collectorNumber,
    item.finish,
    item.condition,
    item.card.scryfallId,
  ];
}

/**
 * Generates Card Conduit CSV manifest(s) (`SPEC.md` §5.1):
 * - Enforces `>= 90%` `P_buy >= $0.50` for `curated` and `100%` `P_buy >= $0.50` for `sorted`.
 * - Sorts `sorted` exports descending by `P_buy` and splits shipments exceeding
 *   500 total cards into numbered batch CSVs (`card-conduit-sorted-batch-1.csv`, ...).
 */
export function exportCardConduitCsv(
  items: readonly ExportableLotItem[],
  options: CardConduitExportOptions = {},
): CardConduitExportResult {
  const tier = options.tier ?? "curated";
  const shouldValidate = options.validate ?? true;
  const maxBatchSize =
    options.maxCardsPerSortedBatch ?? DEFAULT_CONDUIT_SORTED_MAX_CARDS;

  if (!Number.isInteger(maxBatchSize) || maxBatchSize <= 0) {
    throw new RangeError("maxCardsPerSortedBatch must be a positive integer.");
  }

  const targetItems = filterConduitItems(items, options);
  const validation = validateCardConduitShipment(targetItems, tier);

  if (shouldValidate && !validation.valid) {
    throw new CardConduitValidationError({
      message: validation.errorMessage!,
      tier,
      totalCards: validation.totalCards,
      eligibleCards: validation.eligibleCards,
      eligiblePercentage: validation.eligiblePercentage,
    });
  }

  if (targetItems.length === 0) {
    const emptyCsv = serializeCsv(CARD_CONDUIT_HEADERS, []);
    return {
      tier,
      validation,
      totalCards: 0,
      batches: [],
      csv: emptyCsv,
    };
  }

  if (tier !== "sorted") {
    const csvRows = targetItems.map((item) => toConduitCsvRow(item));
    const csv = serializeCsv(CARD_CONDUIT_HEADERS, csvRows);
    const totalCards = targetItems.reduce((sum, item) => sum + item.quantity, 0);
    return {
      tier,
      validation,
      totalCards,
      batches: [
        {
          batchNumber: 1,
          filename: `card-conduit-${tier}.csv`,
          rowCount: csvRows.length,
          totalCards,
          csv,
        },
      ],
      csv,
    };
  }

  // Sorted tier: sort descending by P_buy, then split at 500 total cards per batch
  const sortedItems = [...targetItems].sort((a, b) => {
    const pA = getEffectiveConduitPBuyCents(a);
    const pB = getEffectiveConduitPBuyCents(b);
    if (pA !== pB) {
      return pA > pB ? -1 : 1;
    }
    const byName = a.card.name.localeCompare(b.card.name);
    if (byName !== 0) return byName;
    const bySet = a.card.setCode.localeCompare(b.card.setCode);
    if (bySet !== 0) return bySet;
    return a.card.collectorNumber.localeCompare(b.card.collectorNumber);
  });

  const rawBatches: Array<{
    rows: Array<Array<string | number>>;
    totalCards: number;
  }> = [];

  let currentBatchRows: Array<Array<string | number>> = [];
  let currentBatchCards = 0;

  const flushBatch = () => {
    if (currentBatchRows.length > 0) {
      rawBatches.push({
        rows: currentBatchRows,
        totalCards: currentBatchCards,
      });
      currentBatchRows = [];
      currentBatchCards = 0;
    }
  };

  for (const item of sortedItems) {
    let remainingQty = item.quantity;
    while (remainingQty > 0) {
      if (currentBatchCards === maxBatchSize) {
        flushBatch();
      }
      const capacity = maxBatchSize - currentBatchCards;
      const takeQty = Math.min(remainingQty, capacity);
      currentBatchRows.push(toConduitCsvRow(item, takeQty));
      currentBatchCards += takeQty;
      remainingQty -= takeQty;
    }
  }
  flushBatch();

  const isMultiBatch = rawBatches.length > 1;
  const batches: CardConduitBatchFile[] = rawBatches.map((batch, idx) => {
    const batchNumber = idx + 1;
    const filename = isMultiBatch
      ? `card-conduit-sorted-batch-${batchNumber}.csv`
      : "card-conduit-sorted.csv";
    return {
      batchNumber,
      filename,
      rowCount: batch.rows.length,
      totalCards: batch.totalCards,
      csv: serializeCsv(CARD_CONDUIT_HEADERS, batch.rows),
    };
  });

  const combinedRows = sortedItems.map((item) => toConduitCsvRow(item));
  const totalCards = sortedItems.reduce((sum, item) => sum + item.quantity, 0);

  return {
    tier,
    validation,
    totalCards,
    batches,
    csv:
      batches.length === 1
        ? batches[0]!.csv
        : serializeCsv(CARD_CONDUIT_HEADERS, combinedRows),
  };
}

export type CardKingdomExportMode = "all" | "cash" | "credit";

export interface CardKingdomExportOptions {
  readonly mode?: CardKingdomExportMode;
  /**
   * `"spec"` (default, `SPEC.md` §5.2): `Card Name,Edition,Foil,Quantity`
   * `"ck_title"`: `Title,Edition,Foil,Quantity`
   */
  readonly headerStyle?: "spec" | "ck_title";
  readonly includeConduitRows?: boolean;
}

export interface CsvExportArtifact {
  readonly filename: string;
  readonly rowCount: number;
  readonly totalCards: number;
  readonly csv: string;
}

/**
 * Generates Card Kingdom Buylist CSV (`SPEC.md` §5.2) for `PILE_1_BUYLIST` (`ck_cash`)
 * and/or `PILE_3_CREDIT_ARB` (`ck_credit`).
 */
export function exportCardKingdomBuylistCsv(
  items: readonly ExportableLotItem[],
  options: CardKingdomExportOptions = {},
): CsvExportArtifact {
  const mode = options.mode ?? "all";
  const headers =
    options.headerStyle === "ck_title"
      ? CARD_KINGDOM_BUYLIST_TITLE_HEADERS
      : CARD_KINGDOM_BUYLIST_SPEC_HEADERS;

  const filtered = items.filter((item) => {
    const isCkCash =
      item.assignedBucket === "PILE_1_BUYLIST" &&
      (options.includeConduitRows ||
        item.recommendedChannel === "ck_cash" ||
        !item.recommendedChannel.startsWith("conduit_"));
    const isCkCredit = item.assignedBucket === "PILE_3_CREDIT_ARB";

    if (mode === "cash") return isCkCash;
    if (mode === "credit") return isCkCredit;
    return isCkCash || isCkCredit;
  });

  let totalCards = 0;
  const rows = filtered.map((item) => {
    totalCards += item.quantity;
    const isFoilOrEtched = item.finish === "foil" || item.finish === "etched";
    return [
      item.card.name,
      item.card.setName,
      isFoilOrEtched ? "true" : "false",
      item.quantity,
    ];
  });

  const suffix = mode === "all" ? "buylist" : `buylist-${mode}`;
  return {
    filename: `card-kingdom-${suffix}.csv`,
    rowCount: rows.length,
    totalCards,
    csv: serializeCsv(headers, rows),
  };
}

const TCGPLAYER_CONDITION_LABELS: Readonly<Record<CardCondition, string>> = {
  NM: "Near Mint",
  LP: "Lightly Played",
  MP: "Moderately Played",
  HP: "Heavily Played",
  DMG: "Damaged",
};

export function formatTcgplayerCondition(
  condition: CardCondition,
  finish: CardFinish,
): string {
  const base = TCGPLAYER_CONDITION_LABELS[condition];
  return finish === "normal" ? base : `${base} Foil`;
}

function getCatalogMarketReference(
  card: CatalogPriceFields,
  finish: CardFinish,
): string {
  if (finish === "normal") return card.tcgMarketNm ?? "";
  if (finish === "foil") return card.tcgMarketFoil ?? "";
  return card.tcgMarketEtched ?? card.tcgMarketFoil ?? "";
}

function getCatalogLowReference(
  card: CatalogPriceFields,
  finish: CardFinish,
): string {
  if (finish === "normal") return card.tcgLowNm ?? "";
  if (finish === "foil") return card.tcgLowFoil ?? "";
  return card.tcgLowEtched ?? card.tcgLowFoil ?? "";
}

function resolveExportTcgplayerId(
  card: CatalogPriceFields,
  finish: CardFinish,
): string {
  if (finish === "etched") {
    const id = card.tcgplayerEtchedId ?? card.tcgplayerId;
    return id !== null ? String(id) : "";
  }
  return card.tcgplayerId !== null ? String(card.tcgplayerId) : "";
}

/**
 * Generates TCGplayer Staged Inventory CSV (`SPEC.md` §5.3) for `PILE_2_SINGLES`
 * items routed to `tcgplayer_single`.
 */
export function exportTcgplayerStagedCsv(
  items: readonly ExportableLotItem[],
  options: { includeAllSingles?: boolean } = {},
): CsvExportArtifact {
  const filtered = items.filter(
    (item) =>
      item.assignedBucket === "PILE_2_SINGLES" &&
      (options.includeAllSingles ||
        item.recommendedChannel === "tcgplayer_single"),
  );

  let totalCards = 0;
  const rows = filtered.map((item) => {
    totalCards += item.quantity;
    return [
      resolveExportTcgplayerId(item.card, item.finish),
      "Magic",
      item.card.setName,
      item.card.name,
      item.card.name,
      item.card.collectorNumber,
      item.card.rarity,
      formatTcgplayerCondition(item.condition, item.finish),
      getCatalogMarketReference(item.card, item.finish),
      "",
      "",
      getCatalogLowReference(item.card, item.finish),
      "0",
      item.quantity,
      item.baselines.pRetailTcgUsd,
      "0",
      "",
      "",
    ];
  });

  return {
    filename: "tcgplayer-staged-inventory.csv",
    rowCount: rows.length,
    totalCards,
    csv: serializeCsv(TCGPLAYER_STAGED_HEADERS, rows),
  };
}

/**
 * Generates Mana Pool Staged Singles CSV (`SPEC.md` §5.4) for `PILE_2_SINGLES`
 * items routed to `manapool_single`.
 */
export function exportManapoolStagedCsv(
  items: readonly ExportableLotItem[],
  options: { includeAllSingles?: boolean } = {},
): CsvExportArtifact {
  const filtered = items.filter(
    (item) =>
      item.assignedBucket === "PILE_2_SINGLES" &&
      (options.includeAllSingles ||
        item.recommendedChannel === "manapool_single"),
  );

  let totalCards = 0;
  const rows = filtered.map((item) => {
    totalCards += item.quantity;
    return [
      item.card.scryfallId,
      resolveExportTcgplayerId(item.card, item.finish),
      item.card.setCode.toUpperCase(),
      item.card.collectorNumber,
      item.card.name,
      item.finish,
      item.condition,
      item.language,
      item.quantity,
      item.baselines.pRetailMpUsd,
    ];
  });

  return {
    filename: "manapool-staged-singles.csv",
    rowCount: rows.length,
    totalCards,
    csv: serializeCsv(MANAPOOL_STAGED_HEADERS, rows),
  };
}

export interface P2pClaimMarkdownArtifact {
  readonly filename: string;
  readonly lineItemCount: number;
  readonly totalCards: number;
  readonly totalRetailReferenceUsd: string;
  readonly totalClaimValueUsd: string;
  readonly markdown: string;
}

const FINISH_DISPLAY_LABELS: Readonly<Record<CardFinish, string>> = {
  normal: "Normal",
  foil: "Foil",
  etched: "Etched",
};

interface PriceTierDefinition {
  readonly heading: string;
  readonly minClaimCents: bigint;
  readonly maxClaimCents: bigint | null;
}

const P2P_PRICE_TIERS: readonly PriceTierDefinition[] = [
  {
    heading: "### High-End Staples ($50.00+)",
    minClaimCents: 5000n,
    maxClaimCents: null,
  },
  {
    heading: "### Mid-Tier Staples ($15.00 - $49.99)",
    minClaimCents: 1500n,
    maxClaimCents: 4999n,
  },
  {
    heading: "### Value Singles ($5.00 - $14.99)",
    minClaimCents: 500n,
    maxClaimCents: 1499n,
  },
  {
    heading: "### Under $5 Claims (< $5.00)",
    minClaimCents: 0n,
    maxClaimCents: 499n,
  },
];

/**
 * Generates copy-pasteable Discord / Facebook "85% TCG Low" Claim-Sale Markdown
 * (`SPEC.md` §5.5), grouped cleanly by claim price tier.
 */
export function exportP2pClaimMarkdown(
  items: readonly ExportableLotItem[],
  options: { includeAllSingles?: boolean; title?: string } = {},
): P2pClaimMarkdownArtifact {
  const filtered = items.filter(
    (item) =>
      item.assignedBucket === "PILE_2_SINGLES" &&
      (options.includeAllSingles || item.recommendedChannel === "p2p_85_pct"),
  );

  const enriched = filtered.map((item) => {
    const retailCents = parseRequiredUsdToCents(
      item.baselines.pRetailP2pUsd,
      "pRetailP2pUsd",
    );
    const claimCents = mulCentsByRatioHalfUp(retailCents, 85n, 100n);
    return {
      item,
      retailCents,
      retailUsd: formatCentsToUsd(retailCents),
      claimCents,
      claimUsd: formatCentsToUsd(claimCents),
    };
  });

  enriched.sort((a, b) => {
    if (a.claimCents !== b.claimCents) {
      return a.claimCents > b.claimCents ? -1 : 1;
    }
    return a.item.card.name.localeCompare(b.item.card.name);
  });

  let totalCards = 0;
  let totalRetailCents = 0n;
  let totalClaimCents = 0n;

  for (const entry of enriched) {
    const qty = BigInt(entry.item.quantity);
    totalCards += entry.item.quantity;
    totalRetailCents += qty * entry.retailCents;
    totalClaimCents += qty * entry.claimCents;
  }

  const headingTitle =
    options.title ?? "## MTG Claim Sale — 85% TCG Low (PayPal G&S)";

  if (enriched.length === 0) {
    return {
      filename: "p2p-claim-sale-85pct.md",
      lineItemCount: 0,
      totalCards: 0,
      totalRetailReferenceUsd: "0.00",
      totalClaimValueUsd: "0.00",
      markdown: `${headingTitle}\n\n_No P2P claim-sale singles routed in this lot._`,
    };
  }

  const sections: string[] = [
    headingTitle,
    `**Total Cards:** ${totalCards} | **TCG Low Total:** $${formatCentsToUsd(totalRetailCents)} | **Take-All / Sum of Claims (85%):** $${formatCentsToUsd(totalClaimCents)}`,
  ];

  for (const tier of P2P_PRICE_TIERS) {
    const tierEntries = enriched.filter((entry) => {
      if (entry.claimCents < tier.minClaimCents) return false;
      if (tier.maxClaimCents !== null && entry.claimCents > tier.maxClaimCents) {
        return false;
      }
      return true;
    });

    if (tierEntries.length === 0) {
      continue;
    }

    const lines = tierEntries.map(({ item, retailUsd, claimUsd }) => {
      const finishLabel = FINISH_DISPLAY_LABELS[item.finish];
      const extraTags: string[] = [];
      if (item.language.toLowerCase() !== "en") {
        extraTags.push(item.language.toUpperCase());
      }
      if (item.isAltered) {
        extraTags.push("Altered");
      }
      if (item.isMisprint) {
        extraTags.push("Misprint");
      }
      const tagSuffix =
        extraTags.length > 0 ? `, ${extraTags.join("/")}` : "";
      return `${item.quantity}x ${item.card.name} (${item.card.setCode.toUpperCase()} #${item.card.collectorNumber} - ${item.condition}/${finishLabel}${tagSuffix}) — TCG Low: $${retailUsd} -> Claim: $${claimUsd}`;
    });

    sections.push(`${tier.heading}\n${lines.join("\n")}`);
  }

  return {
    filename: "p2p-claim-sale-85pct.md",
    lineItemCount: enriched.length,
    totalCards,
    totalRetailReferenceUsd: formatCentsToUsd(totalRetailCents),
    totalClaimValueUsd: formatCentsToUsd(totalClaimCents),
    markdown: sections.join("\n\n"),
  };
}

export interface AllLotManifestExports {
  readonly cardConduit: CardConduitExportResult;
  readonly cardKingdomCash: CsvExportArtifact;
  readonly cardKingdomCredit: CsvExportArtifact;
  readonly tcgplayerStaged: CsvExportArtifact;
  readonly manapoolStaged: CsvExportArtifact;
  readonly p2pClaimMarkdown: P2pClaimMarkdownArtifact;
}

/**
 * Convenience bundle generating all vendor & marketplace exports for a routed lot
 * (uses non-throwing Conduit validation when generating preview bundles unless `strictConduitValidation` is set).
 */
export function generateAllLotExports(
  items: readonly ExportableLotItem[],
  options: {
    conduitTier?: ConduitTierPreference;
    strictConduitValidation?: boolean;
  } = {},
): AllLotManifestExports {
  return {
    cardConduit: exportCardConduitCsv(items, {
      tier: options.conduitTier ?? "curated",
      validate: options.strictConduitValidation ?? false,
    }),
    cardKingdomCash: exportCardKingdomBuylistCsv(items, { mode: "cash" }),
    cardKingdomCredit: exportCardKingdomBuylistCsv(items, { mode: "credit" }),
    tcgplayerStaged: exportTcgplayerStagedCsv(items),
    manapoolStaged: exportManapoolStagedCsv(items),
    p2pClaimMarkdown: exportP2pClaimMarkdown(items),
  };
}

export type { AssignedBucket, RecommendedChannel };
