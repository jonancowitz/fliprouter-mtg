import crypto from "node:crypto";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { DEMO_USER_ID } from "@/db/demo-cards";
import type { Database } from "@/db/index";
import {
  type AssignedBucket,
  CARD_CONDITIONS,
  CARD_FINISHES,
  COLLECTION_LOT_STATUSES,
  type CardCatalogItem,
  type CardCondition,
  type CardFinish,
  type CollectionLot,
  type CollectionLotStatus,
  CONDUIT_TIERS,
  type ConduitTierPreference,
  cardCatalog,
  collectionLots,
  type LotItem,
  lotItems,
  userRoutingProfiles,
} from "@/db/schema";
import { getCatalogCount } from "@/db/seed-demo";
import { FULL_CATALOG_MIN_THRESHOLD } from "@/lib/catalog";
import {
  fetchFreshSkuPriceCacheMap,
  makeSkuPriceCacheKey,
  normalizeLanguage,
  parseScannerCsv,
  resolveParsedCsvRows,
  SCANNER_FORMATS,
  type ScannerFormat,
} from "@/lib/csv";
import {
  type BuylistCashSelectionMode,
  type CatalogPriceFields,
  DEFAULT_ROUTING_PROFILE,
  divRoundHalfUp,
  evaluateCardRouting,
  evaluatePaidSkuApiEligibility,
  formatBasisPointsToPercent,
  formatCentsToUsd,
  isFreshSkuPriceCache,
  parseUsdToCents,
  type PaidSkuApiSkipReason,
  type RoutedLotSummary,
  type RoutingProfileConfig,
  resolveRoutingProfile,
  routeCollectionLot,
} from "@/lib/routing";
import {
  hydrateRoutingCardInputs,
  type SavedLotDetailResponse,
  type SavedLotListItem,
  type SerializedRoutedSummary,
  type SerializedRoutingCardInput,
  type SerializedRoutingProfile,
  type SerializedSkuCacheFields,
  serializeRoutingProfile,
  serializeSkuCache,
  type TriageDiagnostics,
  type TriageIngestResponse,
} from "./types";

/** Maximum currency cents storable in PostgreSQL `NUMERIC(10, 2)` ($99,999,999.99). */
export const MAX_NUMERIC_10_2_CENTS = 9_999_999_999n;

/** Maximum scanner CSV upload payload (5 MB) and row count guard. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 25_000;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const BUYLIST_CASH_MODES: readonly BuylistCashSelectionMode[] = [
  "best",
  "ck_direct",
  "conduit",
] as const;

export class TriageValidationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "TriageValidationError";
    this.statusCode = statusCode;
  }
}

export function assertPlainObject(
  value: unknown,
  label = "Request body",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TriageValidationError(`${label} must be a JSON object.`, 400);
  }
  return value as Record<string, unknown>;
}

export async function parseJsonObjectBody(
  request: Request,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new TriageValidationError("Invalid JSON request body.", 400);
  }
  return assertPlainObject(parsed, "Request body");
}

export function assertValidUuid(raw: unknown, fieldName = "id"): string {
  if (typeof raw !== "string" || !UUID_REGEX.test(raw.trim())) {
    throw new TriageValidationError(
      `Invalid UUID for ${fieldName}: "${String(raw)}".`,
      400,
    );
  }
  return raw.trim().toLowerCase();
}

export function normalizeNonNegativeUsdField(
  raw: unknown,
  fieldName: string,
  options: { allowEmptyAsZero?: boolean } = {},
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    if (options.allowEmptyAsZero) {
      return "0.00";
    }
    throw new TriageValidationError(
      `${fieldName} must be a non-negative USD amount.`,
      400,
    );
  }

  let candidateStr: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new TriageValidationError(
        `${fieldName} must be a finite USD amount.`,
        400,
      );
    }
    if (raw < 0) {
      throw new TriageValidationError(`${fieldName} cannot be negative.`, 400);
    }
    if (raw > 99_999_999.99) {
      throw new TriageValidationError(
        `${fieldName} exceeds maximum supported amount ($99,999,999.99).`,
        400,
      );
    }
    candidateStr = raw.toFixed(4);
  } else if (typeof raw === "string") {
    if (raw.trim() === "") {
      if (options.allowEmptyAsZero) {
        return "0.00";
      }
      throw new TriageValidationError(`${fieldName} cannot be empty.`, 400);
    }
    candidateStr = raw;
  } else {
    throw new TriageValidationError(
      `${fieldName} must be a USD string or number.`,
      400,
    );
  }

  let cents: bigint | null;
  try {
    cents = parseUsdToCents(candidateStr);
  } catch {
    throw new TriageValidationError(
      `Invalid USD amount for ${fieldName}: "${String(raw)}".`,
      400,
    );
  }

  if (cents === null) {
    if (options.allowEmptyAsZero) {
      return "0.00";
    }
    throw new TriageValidationError(`${fieldName} cannot be empty.`, 400);
  }
  if (cents < 0n) {
    throw new TriageValidationError(`${fieldName} cannot be negative.`, 400);
  }
  if (cents > MAX_NUMERIC_10_2_CENTS) {
    throw new TriageValidationError(
      `${fieldName} exceeds maximum supported amount ($99,999,999.99).`,
      400,
    );
  }
  return formatCentsToUsd(cents);
}

function normalizeOptionalNullableUsd(
  raw: unknown,
  fieldName: string,
): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === "string" && raw.trim() === "") {
    return null;
  }
  return normalizeNonNegativeUsdField(raw, fieldName) ?? null;
}

export function validatePurchaseDate(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new TriageValidationError(
      "purchaseDate must be a YYYY-MM-DD date string.",
      400,
    );
  }
  const trimmed = raw.trim();
  const match = ISO_DATE_REGEX.exec(trimmed);
  if (!match) {
    throw new TriageValidationError(
      `Invalid purchaseDate "${raw}". Expected YYYY-MM-DD.`,
      400,
    );
  }
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() + 1 !== month ||
    utc.getUTCDate() !== day
  ) {
    throw new TriageValidationError(
      `Invalid calendar date for purchaseDate: "${raw}".`,
      400,
    );
  }
  return trimmed;
}

export function validateBuylistCashMode(raw: unknown): BuylistCashSelectionMode {
  if (raw === undefined || raw === null) {
    return "best";
  }
  if (
    typeof raw !== "string" ||
    !BUYLIST_CASH_MODES.includes(raw as BuylistCashSelectionMode)
  ) {
    throw new TriageValidationError(
      `Invalid buylistCashMode "${String(raw)}". Expected one of: ${BUYLIST_CASH_MODES.join(", ")}.`,
      400,
    );
  }
  return raw as BuylistCashSelectionMode;
}

export function validateScannerFormat(raw: unknown): ScannerFormat | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (
    typeof raw !== "string" ||
    !SCANNER_FORMATS.includes(raw as ScannerFormat)
  ) {
    throw new TriageValidationError(
      `Unsupported scanner format "${String(raw)}". Expected one of: ${SCANNER_FORMATS.join(", ")}.`,
      400,
    );
  }
  return raw as ScannerFormat;
}

function assertSummaryFitsNumeric10_2(summary: RoutedLotSummary): void {
  if (summary.estimatedGrossValueCents > MAX_NUMERIC_10_2_CENTS) {
    throw new TriageValidationError(
      "Lot estimated gross value exceeds NUMERIC(10, 2) maximum ($99,999,999.99).",
      400,
    );
  }
  if (
    summary.estimatedNetPayoutCents > MAX_NUMERIC_10_2_CENTS ||
    summary.estimatedNetPayoutCents < -MAX_NUMERIC_10_2_CENTS
  ) {
    throw new TriageValidationError(
      "Lot estimated net payout exceeds NUMERIC(10, 2) bounds.",
      400,
    );
  }
}

/**
 * Generates RFC-4122 v4 UUIDs sharing a random 72-bit batch prefix and monotonic
 * 48-bit suffix (`000000000000`, `000000000001`, ...) so `ORDER BY item_id ASC`
 * deterministically preserves exact item insertion order.
 */
function generateOrderedLotItemIds(count: number): string[] {
  const prefixHex = crypto.randomBytes(9).toString("hex"); // 18 hex chars
  const p1 = prefixHex.slice(0, 8);
  const p2 = prefixHex.slice(8, 12);
  const p3 = prefixHex.slice(12, 15);
  const p4 = prefixHex.slice(15, 18);
  const ids: string[] = [];
  for (let idx = 0; idx < count; idx += 1) {
    const seq = idx.toString(16).padStart(12, "0");
    ids.push(`${p1}-${p2}-4${p3}-8${p4}-${seq}`);
  }
  return ids;
}

export function serializeRoutedSummary(
  summary: RoutedLotSummary,
): SerializedRoutedSummary {
  return {
    totalLineItems: summary.totalLineItems,
    totalCards: summary.totalCards,
    purchaseCostUsd: summary.purchaseCostUsd,
    allocatedCostBasisSumUsd: summary.allocatedCostBasisSumUsd,
    estimatedGrossValueUsd: summary.estimatedGrossValueUsd,
    subtotalItemNetPayoutUsd: summary.subtotalItemNetPayoutUsd,
    outboundBoxCount: summary.outboundBoxCount,
    outboundBoxShippingUsd: summary.outboundBoxShippingUsd,
    estimatedNetPayoutUsd: summary.estimatedNetPayoutUsd,
    estimatedNetProfitUsd: summary.estimatedNetProfitUsd,
    estimatedNetRoiPct: summary.estimatedNetRoiPct,
    status: summary.status,
    vendorShipments: summary.vendorShipments.map((s) => ({
      vendor: s.vendor,
      totalCards: s.totalCards,
      grossBuylistNetUsd: s.grossBuylistNetUsd,
      fallbackNetUsd: s.fallbackNetUsd,
      boxShippingUsd: s.boxShippingUsd,
      demotedToNonBuylist: s.demotedToNonBuylist,
    })),
    buckets: summary.buckets,
  };
}

export function sanitizeProfilePatch(
  rawPatch?: Partial<SerializedRoutingProfile> | Record<string, unknown>,
): Partial<RoutingProfileConfig> {
  if (rawPatch === undefined || rawPatch === null) return {};
  const patch = assertPlainObject(rawPatch, "profile");
  const out: Partial<RoutingProfileConfig> = {};

  const labor = normalizeNonNegativeUsdField(
    patch.hourlyLaborRateUsd,
    "hourlyLaborRateUsd",
  );
  if (labor !== undefined) out.hourlyLaborRateUsd = labor;

  if (patch.secondsPerSingleOrder !== undefined) {
    const secs = patch.secondsPerSingleOrder;
    if (
      typeof secs !== "number" ||
      !Number.isInteger(secs) ||
      secs < 0 ||
      secs > 3600
    ) {
      throw new TriageValidationError(
        "secondsPerSingleOrder must be an integer between 0 and 3600.",
      );
    }
    out.secondsPerSingleOrder = secs;
  }

  const pwe = normalizeNonNegativeUsdField(
    patch.pweShippingCostUsd,
    "pweShippingCostUsd",
  );
  if (pwe !== undefined) out.pweShippingCostUsd = pwe;

  const tracked = normalizeNonNegativeUsdField(
    patch.trackedShippingCostUsd,
    "trackedShippingCostUsd",
  );
  if (tracked !== undefined) out.trackedShippingCostUsd = tracked;

  const threshold = normalizeNonNegativeUsdField(
    patch.trackedThresholdUsd,
    "trackedThresholdUsd",
  );
  if (threshold !== undefined) out.trackedThresholdUsd = threshold;

  const boxShip = normalizeNonNegativeUsdField(
    patch.outboundBuylistBoxShippingUsd,
    "outboundBuylistBoxShippingUsd",
  );
  if (boxShip !== undefined) out.outboundBuylistBoxShippingUsd = boxShip;

  const minGain = normalizeNonNegativeUsdField(
    patch.minSingleNetGainOverBuylistUsd,
    "minSingleNetGainOverBuylistUsd",
  );
  if (minGain !== undefined) out.minSingleNetGainOverBuylistUsd = minGain;

  if (patch.enableCreditArbitrage !== undefined) {
    if (typeof patch.enableCreditArbitrage !== "boolean") {
      throw new TriageValidationError(
        "enableCreditArbitrage must be a boolean.",
      );
    }
    out.enableCreditArbitrage = patch.enableCreditArbitrage;
  }

  if (patch.conduitTierPreference !== undefined) {
    if (
      typeof patch.conduitTierPreference !== "string" ||
      !CONDUIT_TIERS.includes(
        patch.conduitTierPreference as ConduitTierPreference,
      )
    ) {
      throw new TriageValidationError(
        `Invalid conduitTierPreference: "${String(patch.conduitTierPreference)}"`,
      );
    }
    out.conduitTierPreference =
      patch.conduitTierPreference as ConduitTierPreference;
  }

  if (patch.monthlySkuApiQuota !== undefined) {
    const quota = patch.monthlySkuApiQuota;
    if (
      typeof quota !== "number" ||
      !Number.isInteger(quota) ||
      quota < 0 ||
      quota > 100_000_000
    ) {
      throw new TriageValidationError(
        "monthlySkuApiQuota must be a non-negative integer.",
      );
    }
    out.monthlySkuApiQuota = quota;
  }

  if (patch.monthlySkuApiUsed !== undefined) {
    const used = patch.monthlySkuApiUsed;
    if (
      typeof used !== "number" ||
      !Number.isInteger(used) ||
      used < 0 ||
      used > 100_000_000
    ) {
      throw new TriageValidationError(
        "monthlySkuApiUsed must be a non-negative integer.",
      );
    }
    out.monthlySkuApiUsed = used;
  }

  if (patch.skuApiQuotaResetAt !== undefined) {
    const rawReset = patch.skuApiQuotaResetAt;
    if (typeof rawReset !== "string" && !(rawReset instanceof Date)) {
      throw new TriageValidationError(
        "skuApiQuotaResetAt must be an ISO timestamp string.",
      );
    }
    const parsedReset =
      rawReset instanceof Date ? rawReset : new Date(rawReset);
    if (Number.isNaN(parsedReset.getTime())) {
      throw new TriageValidationError(
        `Invalid skuApiQuotaResetAt timestamp: "${String(rawReset)}".`,
      );
    }
    out.skuApiQuotaResetAt = parsedReset;
  }

  return out;
}

export async function getOrCreateUserRoutingProfile(
  db: Database,
  userId: string = DEMO_USER_ID,
): Promise<RoutingProfileConfig> {
  const existing = await db
    .select()
    .from(userRoutingProfiles)
    .where(eq(userRoutingProfiles.userId, userId));

  if (existing[0]) {
    return existing[0];
  }

  const [inserted] = await db
    .insert(userRoutingProfiles)
    .values({
      userId,
      ...DEFAULT_ROUTING_PROFILE,
      monthlySkuApiQuota: 2500,
      monthlySkuApiUsed: 2,
    })
    .onConflictDoNothing({ target: userRoutingProfiles.userId })
    .returning();

  if (inserted) {
    return inserted;
  }

  const refetched = await db
    .select()
    .from(userRoutingProfiles)
    .where(eq(userRoutingProfiles.userId, userId));
  return refetched[0] ?? DEFAULT_ROUTING_PROFILE;
}

export async function upsertUserRoutingProfile(
  db: Database,
  patch: Partial<SerializedRoutingProfile> | Record<string, unknown>,
  userId: string = DEMO_USER_ID,
): Promise<RoutingProfileConfig> {
  const current = await getOrCreateUserRoutingProfile(db, userId);
  const sanitized = sanitizeProfilePatch(patch);
  const merged = resolveRoutingProfile({ ...current, ...sanitized });

  const resetAtPatch = merged.skuApiQuotaResetAt
    ? { skuApiQuotaResetAt: merged.skuApiQuotaResetAt }
    : {};

  const [updated] = await db
    .insert(userRoutingProfiles)
    .values({
      userId,
      hourlyLaborRateUsd: merged.hourlyLaborRateUsd,
      secondsPerSingleOrder: merged.secondsPerSingleOrder,
      pweShippingCostUsd: merged.pweShippingCostUsd,
      trackedShippingCostUsd: merged.trackedShippingCostUsd,
      trackedThresholdUsd: merged.trackedThresholdUsd,
      outboundBuylistBoxShippingUsd: merged.outboundBuylistBoxShippingUsd,
      minSingleNetGainOverBuylistUsd: merged.minSingleNetGainOverBuylistUsd,
      enableCreditArbitrage: merged.enableCreditArbitrage,
      conduitTierPreference: merged.conduitTierPreference,
      monthlySkuApiQuota: merged.monthlySkuApiQuota,
      monthlySkuApiUsed: merged.monthlySkuApiUsed,
      ...resetAtPatch,
    })
    .onConflictDoUpdate({
      target: userRoutingProfiles.userId,
      set: {
        hourlyLaborRateUsd: merged.hourlyLaborRateUsd,
        secondsPerSingleOrder: merged.secondsPerSingleOrder,
        pweShippingCostUsd: merged.pweShippingCostUsd,
        trackedShippingCostUsd: merged.trackedShippingCostUsd,
        trackedThresholdUsd: merged.trackedThresholdUsd,
        outboundBuylistBoxShippingUsd: merged.outboundBuylistBoxShippingUsd,
        minSingleNetGainOverBuylistUsd: merged.minSingleNetGainOverBuylistUsd,
        enableCreditArbitrage: merged.enableCreditArbitrage,
        conduitTierPreference: merged.conduitTierPreference,
        monthlySkuApiQuota: merged.monthlySkuApiQuota,
        monthlySkuApiUsed: merged.monthlySkuApiUsed,
        ...resetAtPatch,
      },
    })
    .returning();

  return updated ?? merged;
}

/**
 * Fail-soft copy when a personal scanner CSV mostly hits `catalog_not_found`
 * against the 44-card demo seed (full sync not run yet).
 */
export function buildDemoCatalogGuidance(params: {
  catalogCount: number;
  isFullCatalog: boolean;
  totalParsedRows: number;
  resolvedRows: number;
  catalogNotFoundCount: number;
}): string | null {
  if (params.isFullCatalog) {
    return null;
  }
  if (params.totalParsedRows === 0 || params.catalogNotFoundCount === 0) {
    return null;
  }
  // Demo catalog miss: any catalog_not_found while still under the full-catalog
  // threshold means the user needs Sync Full Catalog for real collections.
  const unresolvedMajority =
    params.catalogNotFoundCount >= Math.max(1, Math.ceil(params.totalParsedRows / 2)) ||
    params.resolvedRows === 0;
  if (!unresolvedMajority) {
    return null;
  }
  return (
    `Local catalog has only ${params.catalogCount.toLocaleString("en-US")} demo printings ` +
    `(need ${FULL_CATALOG_MIN_THRESHOLD.toLocaleString("en-US")}+ for personal CSVs). ` +
    `Click "Sync Full 100k+ Catalog" (or run npm run catalog:sync), then re-upload. ` +
    `Demo presets still resolve against the starter seed.`
  );
}

export async function ingestAndRouteScannerCsv(
  db: Database,
  params: {
    csvText: unknown;
    format?: unknown;
    purchaseCostUsd?: unknown;
    profile?: Partial<SerializedRoutingProfile> | Record<string, unknown>;
    buylistCashMode?: unknown;
    userId?: string;
    now?: Date;
  },
): Promise<TriageIngestResponse> {
  const now = params.now ?? new Date();
  const userId = params.userId ?? DEMO_USER_ID;

  if (typeof params.csvText !== "string" || params.csvText.trim() === "") {
    throw new TriageValidationError("Scanner CSV text is required.", 400);
  }
  if (Buffer.byteLength(params.csvText, "utf8") > MAX_CSV_BYTES) {
    throw new TriageValidationError(
      "CSV payload exceeds maximum 5 MB limit.",
      413,
    );
  }

  const format = validateScannerFormat(params.format);
  const buylistCashMode = validateBuylistCashMode(params.buylistCashMode);

  const storedProfile = await getOrCreateUserRoutingProfile(db, userId);
  const effectiveProfile = resolveRoutingProfile({
    ...storedProfile,
    ...sanitizeProfilePatch(params.profile),
  });

  const purchaseCostUsd =
    normalizeNonNegativeUsdField(
      params.purchaseCostUsd ?? "0.00",
      "purchaseCostUsd",
      { allowEmptyAsZero: true },
    ) ?? "0.00";

  const parsed = parseScannerCsv(params.csvText, { format });
  if (parsed.rows.length > MAX_CSV_ROWS) {
    throw new TriageValidationError(
      `CSV exceeds maximum supported row count (${MAX_CSV_ROWS} rows).`,
      400,
    );
  }

  const resolution = await resolveParsedCsvRows(parsed.rows, db);
  const catalogCount = await getCatalogCount(db);
  const isFullCatalog = catalogCount >= FULL_CATALOG_MIN_THRESHOLD;
  const catalogNotFoundCount = resolution.unresolved.filter(
    (u) => u.reason === "catalog_not_found",
  ).length;
  const catalogGuidance = buildDemoCatalogGuidance({
    catalogCount,
    isFullCatalog,
    totalParsedRows: parsed.rows.length,
    resolvedRows: resolution.stats.resolvedRows,
    catalogNotFoundCount,
  });
  const skuCacheMap = await fetchFreshSkuPriceCacheMap(
    db,
    resolution.resolved,
    now,
  );

  const matchStrategyCounts: TriageDiagnostics["matchStrategyCounts"] = {};
  const skipReasons: Partial<Record<PaidSkuApiSkipReason, number>> = {};
  let freshSkuCacheHitCount = 0;
  let proSkuApiEligibleCount = 0;

  // Track remaining monthly SKU API quota across unique (scryfallId, finish, condition) SKUs
  const quotaResetElapsed =
    effectiveProfile.skuApiQuotaResetAt !== undefined &&
    effectiveProfile.skuApiQuotaResetAt.getTime() <= now.getTime();
  let simulatedMonthlyUsed = quotaResetElapsed
    ? 0
    : effectiveProfile.monthlySkuApiUsed;
  const seenBatchEligibleSkuKeys = new Set<string>();

  const serializedInputs: SerializedRoutingCardInput[] =
    resolution.resolved.map((row) => {
      matchStrategyCounts[row.matchedBy] =
        (matchStrategyCounts[row.matchedBy] ?? 0) + 1;

      const cacheKey = makeSkuPriceCacheKey(
        row.card.scryfallId,
        row.effectiveFinish,
        row.parsedRow.condition,
      );
      const skuEntry = skuCacheMap.get(cacheKey) ?? null;
      const hasFreshCache = isFreshSkuPriceCache(
        skuEntry,
        {
          scryfallId: row.card.scryfallId,
          finish: row.effectiveFinish,
          condition: row.parsedRow.condition,
        },
        now,
      );
      if (hasFreshCache) {
        freshSkuCacheHitCount += 1;
      }

      if (!hasFreshCache && seenBatchEligibleSkuKeys.has(cacheKey)) {
        skipReasons.fresh_cache_hit = (skipReasons.fresh_cache_hit ?? 0) + 1;
      } else {
        const eligibility = evaluatePaidSkuApiEligibility(
          {
            card: row.card,
            finish: row.effectiveFinish,
            condition: row.parsedRow.condition,
            quantity: row.parsedRow.quantity,
            language: row.parsedRow.language,
            isAltered: row.parsedRow.isAltered,
            isMisprint: row.parsedRow.isMisprint,
            skuPriceCache: skuEntry,
          },
          {
            ...effectiveProfile,
            monthlySkuApiUsed: simulatedMonthlyUsed,
            skuApiQuotaResetAt: undefined,
          },
          { now },
        );

        if (eligibility.eligible) {
          proSkuApiEligibleCount += 1;
          simulatedMonthlyUsed += 1;
          seenBatchEligibleSkuKeys.add(cacheKey);
        } else if (eligibility.skipReason) {
          skipReasons[eligibility.skipReason] =
            (skipReasons[eligibility.skipReason] ?? 0) + 1;
        }
      }

      return {
        card: row.card,
        finish: row.effectiveFinish,
        condition: row.parsedRow.condition,
        quantity: row.parsedRow.quantity,
        language: row.parsedRow.language,
        isAltered: row.parsedRow.isAltered,
        isMisprint: row.parsedRow.isMisprint,
        matchedBy: row.matchedBy,
        finishListedInCatalog: row.finishListedInCatalog,
        skuPriceCache: serializeSkuCache(skuEntry),
      };
    });

  const localDbOnlyCount =
    resolution.stats.resolvedRows - freshSkuCacheHitCount;
  const localCoverageBps =
    resolution.stats.resolvedRows > 0
      ? divRoundHalfUp(
          BigInt(localDbOnlyCount) * 10_000n,
          BigInt(resolution.stats.resolvedRows),
        )
      : 10_000n;

  const routingInputs = hydrateRoutingCardInputs(serializedInputs);
  const routed = routeCollectionLot({
    purchaseCostUsd,
    items: routingInputs,
    profile: effectiveProfile,
    options: { now, buylistCashMode },
  });
  assertSummaryFitsNumeric10_2(routed.summary);

  const diagnostics: TriageDiagnostics = {
    scannerFormat: parsed.format,
    headers: parsed.headers,
    totalParsedRows: parsed.rows.length,
    totalResolvedRows: resolution.stats.resolvedRows,
    totalResolvedCards: resolution.stats.totalResolvedCards,
    unresolvedRowCount: resolution.stats.unresolvedRows,
    catalogNotFoundCount,
    skippedRowCount: parsed.skippedRows.length,
    localDbOnlyCount,
    freshSkuCacheHitCount,
    localDbCoveragePct: formatBasisPointsToPercent(localCoverageBps),
    proSkuApiEligibleCount,
    proSkuApiSkipReasons: skipReasons,
    matchStrategyCounts,
    unresolvedRows: resolution.unresolved.map((u) => ({
      rowNumber: u.rowNumber,
      reason: u.reason,
      cardName: u.parsedRow.cardName,
      setCode: u.parsedRow.setCode,
      collectorNumber: u.parsedRow.collectorNumber,
      attemptedStrategies: u.attemptedStrategies,
    })),
    skippedRows: parsed.skippedRows,
    catalogCount,
    isFullCatalog,
    catalogGuidance,
  };

  return {
    diagnostics,
    inputs: serializedInputs,
    profile: serializeRoutingProfile(effectiveProfile),
    buylistCashMode,
    evaluatedAt: now.toISOString(),
    summary: serializeRoutedSummary(routed.summary),
  };
}

function validateLotStatus(raw: unknown): CollectionLotStatus {
  if (raw === undefined || raw === null || raw === "") return "triaged";
  if (
    typeof raw !== "string" ||
    !COLLECTION_LOT_STATUSES.includes(raw as CollectionLotStatus)
  ) {
    throw new TriageValidationError(
      `Invalid lot status "${String(raw)}". Expected one of: ${COLLECTION_LOT_STATUSES.join(", ")}.`,
    );
  }
  return raw as CollectionLotStatus;
}

function validateOptionalIntId(
  raw: unknown,
  fieldName: string,
): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new TriageValidationError(
      `${fieldName} must be a non-negative integer or null.`,
    );
  }
  return raw;
}

async function validateAndSanitizeSerializedInputs(
  db: Database,
  rawInputs: unknown,
): Promise<SerializedRoutingCardInput[]> {
  if (!Array.isArray(rawInputs)) {
    throw new TriageValidationError("inputs must be an array.", 400);
  }
  if (rawInputs.length === 0) {
    throw new TriageValidationError(
      "Cannot persist an empty lot with 0 resolved cards.",
      400,
    );
  }
  if (rawInputs.length > MAX_CSV_ROWS) {
    throw new TriageValidationError(
      `inputs exceeds maximum supported row count (${MAX_CSV_ROWS}).`,
      400,
    );
  }

  const sanitized: SerializedRoutingCardInput[] = rawInputs.map(
    (rawEntry, idx) => {
      const entry = assertPlainObject(rawEntry, `inputs[${idx}]`);
      const rawCard = assertPlainObject(entry.card, `inputs[${idx}].card`);

      const scryfallId = assertValidUuid(
        rawCard.scryfallId,
        `inputs[${idx}].card.scryfallId`,
      );
      if (typeof rawCard.name !== "string" || rawCard.name.trim() === "") {
        throw new TriageValidationError(
          `inputs[${idx}].card.name must be a non-empty string.`,
        );
      }
      if (
        typeof rawCard.setCode !== "string" ||
        rawCard.setCode.trim() === ""
      ) {
        throw new TriageValidationError(
          `inputs[${idx}].card.setCode must be a non-empty string.`,
        );
      }
      if (typeof rawCard.setName !== "string") {
        throw new TriageValidationError(
          `inputs[${idx}].card.setName must be a string.`,
        );
      }
      if (
        typeof rawCard.collectorNumber !== "string" ||
        rawCard.collectorNumber.trim() === ""
      ) {
        throw new TriageValidationError(
          `inputs[${idx}].card.collectorNumber must be a non-empty string.`,
        );
      }
      if (typeof rawCard.rarity !== "string") {
        throw new TriageValidationError(
          `inputs[${idx}].card.rarity must be a string.`,
        );
      }
      if (
        !Array.isArray(rawCard.finishes) ||
        !rawCard.finishes.every((f) => typeof f === "string")
      ) {
        throw new TriageValidationError(
          `inputs[${idx}].card.finishes must be an array of strings.`,
        );
      }

      const finish = entry.finish;
      if (
        typeof finish !== "string" ||
        !CARD_FINISHES.includes(finish as CardFinish)
      ) {
        throw new TriageValidationError(
          `Invalid finish on inputs[${idx}]: "${String(finish)}".`,
        );
      }

      const condition = entry.condition;
      if (
        typeof condition !== "string" ||
        !CARD_CONDITIONS.includes(condition as CardCondition)
      ) {
        throw new TriageValidationError(
          `Invalid condition on inputs[${idx}]: "${String(condition)}".`,
        );
      }

      const quantity = entry.quantity;
      if (
        typeof quantity !== "number" ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 100_000
      ) {
        throw new TriageValidationError(
          `inputs[${idx}].quantity must be an integer between 1 and 100000.`,
        );
      }

      if (
        entry.language !== undefined &&
        typeof entry.language !== "string"
      ) {
        throw new TriageValidationError(
          `inputs[${idx}].language must be a string.`,
        );
      }
      const language = normalizeLanguage(
        typeof entry.language === "string" ? entry.language : "en",
      );

      if (
        entry.isAltered !== undefined &&
        typeof entry.isAltered !== "boolean"
      ) {
        throw new TriageValidationError(
          `inputs[${idx}].isAltered must be a boolean.`,
        );
      }
      if (
        entry.isMisprint !== undefined &&
        typeof entry.isMisprint !== "boolean"
      ) {
        throw new TriageValidationError(
          `inputs[${idx}].isMisprint must be a boolean.`,
        );
      }

      const card: CatalogPriceFields = {
        scryfallId,
        name: rawCard.name,
        setCode: rawCard.setCode,
        setName: rawCard.setName,
        collectorNumber: rawCard.collectorNumber,
        rarity: rawCard.rarity,
        finishes: rawCard.finishes as string[],
        tcgplayerId: validateOptionalIntId(
          rawCard.tcgplayerId,
          `inputs[${idx}].card.tcgplayerId`,
        ),
        tcgplayerEtchedId: validateOptionalIntId(
          rawCard.tcgplayerEtchedId,
          `inputs[${idx}].card.tcgplayerEtchedId`,
        ),
        cardkingdomId: validateOptionalIntId(
          rawCard.cardkingdomId,
          `inputs[${idx}].card.cardkingdomId`,
        ),
        cardkingdomFoilId: validateOptionalIntId(
          rawCard.cardkingdomFoilId,
          `inputs[${idx}].card.cardkingdomFoilId`,
        ),
        tcgMarketNm: normalizeOptionalNullableUsd(
          rawCard.tcgMarketNm,
          `inputs[${idx}].card.tcgMarketNm`,
        ),
        tcgLowNm: normalizeOptionalNullableUsd(
          rawCard.tcgLowNm,
          `inputs[${idx}].card.tcgLowNm`,
        ),
        tcgMarketFoil: normalizeOptionalNullableUsd(
          rawCard.tcgMarketFoil,
          `inputs[${idx}].card.tcgMarketFoil`,
        ),
        tcgLowFoil: normalizeOptionalNullableUsd(
          rawCard.tcgLowFoil,
          `inputs[${idx}].card.tcgLowFoil`,
        ),
        tcgMarketEtched: normalizeOptionalNullableUsd(
          rawCard.tcgMarketEtched,
          `inputs[${idx}].card.tcgMarketEtched`,
        ),
        tcgLowEtched: normalizeOptionalNullableUsd(
          rawCard.tcgLowEtched,
          `inputs[${idx}].card.tcgLowEtched`,
        ),
        manapoolLowNm: normalizeOptionalNullableUsd(
          rawCard.manapoolLowNm,
          `inputs[${idx}].card.manapoolLowNm`,
        ),
        manapoolLowFoil: normalizeOptionalNullableUsd(
          rawCard.manapoolLowFoil,
          `inputs[${idx}].card.manapoolLowFoil`,
        ),
        manapoolLowEtched: normalizeOptionalNullableUsd(
          rawCard.manapoolLowEtched,
          `inputs[${idx}].card.manapoolLowEtched`,
        ),
        ckBuylistCashNm: normalizeOptionalNullableUsd(
          rawCard.ckBuylistCashNm,
          `inputs[${idx}].card.ckBuylistCashNm`,
        ),
        ckBuylistCreditNm: normalizeOptionalNullableUsd(
          rawCard.ckBuylistCreditNm,
          `inputs[${idx}].card.ckBuylistCreditNm`,
        ),
        ckBuylistCashFoil: normalizeOptionalNullableUsd(
          rawCard.ckBuylistCashFoil,
          `inputs[${idx}].card.ckBuylistCashFoil`,
        ),
        ckBuylistCreditFoil: normalizeOptionalNullableUsd(
          rawCard.ckBuylistCreditFoil,
          `inputs[${idx}].card.ckBuylistCreditFoil`,
        ),
        ckBuylistCashEtched: normalizeOptionalNullableUsd(
          rawCard.ckBuylistCashEtched,
          `inputs[${idx}].card.ckBuylistCashEtched`,
        ),
        ckBuylistCreditEtched: normalizeOptionalNullableUsd(
          rawCard.ckBuylistCreditEtched,
          `inputs[${idx}].card.ckBuylistCreditEtched`,
        ),
      };

      let skuCache: SerializedSkuCacheFields | null = null;
      if (entry.skuPriceCache !== undefined && entry.skuPriceCache !== null) {
        const rawCache = assertPlainObject(
          entry.skuPriceCache,
          `inputs[${idx}].skuPriceCache`,
        );
        const cacheScryfallId = assertValidUuid(
          rawCache.scryfallId,
          `inputs[${idx}].skuPriceCache.scryfallId`,
        );
        if (
          typeof rawCache.finish !== "string" ||
          !CARD_FINISHES.includes(rawCache.finish as CardFinish)
        ) {
          throw new TriageValidationError(
            `Invalid skuPriceCache.finish on inputs[${idx}].`,
          );
        }
        if (
          typeof rawCache.condition !== "string" ||
          !CARD_CONDITIONS.includes(rawCache.condition as CardCondition)
        ) {
          throw new TriageValidationError(
            `Invalid skuPriceCache.condition on inputs[${idx}].`,
          );
        }
        if (typeof rawCache.expiresAt !== "string") {
          throw new TriageValidationError(
            `inputs[${idx}].skuPriceCache.expiresAt must be an ISO string.`,
          );
        }
        const expDate = new Date(rawCache.expiresAt);
        if (Number.isNaN(expDate.getTime())) {
          throw new TriageValidationError(
            `Invalid skuPriceCache.expiresAt on inputs[${idx}].`,
          );
        }
        skuCache = {
          scryfallId: cacheScryfallId,
          finish: rawCache.finish as CardFinish,
          condition: rawCache.condition as CardCondition,
          retailLowUsd: normalizeOptionalNullableUsd(
            rawCache.retailLowUsd,
            `inputs[${idx}].skuPriceCache.retailLowUsd`,
          ),
          retailMarketUsd: normalizeOptionalNullableUsd(
            rawCache.retailMarketUsd,
            `inputs[${idx}].skuPriceCache.retailMarketUsd`,
          ),
          buylistCashUsd: normalizeOptionalNullableUsd(
            rawCache.buylistCashUsd,
            `inputs[${idx}].skuPriceCache.buylistCashUsd`,
          ),
          buylistCreditUsd: normalizeOptionalNullableUsd(
            rawCache.buylistCreditUsd,
            `inputs[${idx}].skuPriceCache.buylistCreditUsd`,
          ),
          source:
            typeof rawCache.source === "string" && rawCache.source.trim() !== ""
              ? rawCache.source.slice(0, 32)
              : "tcgapis",
          expiresAt: expDate.toISOString(),
        };
      }

      return {
        card,
        finish: finish as CardFinish,
        condition: condition as CardCondition,
        quantity,
        language,
        isAltered: Boolean(entry.isAltered),
        isMisprint: Boolean(entry.isMisprint),
        skuPriceCache: skuCache,
        conduitBuylistCashUsd: normalizeOptionalNullableUsd(
          entry.conduitBuylistCashUsd,
          `inputs[${idx}].conduitBuylistCashUsd`,
        ),
        lockedAllocatedCostBasisUsd: normalizeOptionalNullableUsd(
          entry.lockedAllocatedCostBasisUsd,
          `inputs[${idx}].lockedAllocatedCostBasisUsd`,
        ),
      };
    },
  );

  // Verify all referenced Scryfall UUIDs exist in card_catalog before FK insert
  const uniqueScryfallIds = [
    ...new Set(sanitized.map((i) => i.card.scryfallId)),
  ];
  const existingCatalogRows = await db
    .select({ scryfallId: cardCatalog.scryfallId })
    .from(cardCatalog)
    .where(inArray(cardCatalog.scryfallId, uniqueScryfallIds));
  const foundSet = new Set(
    existingCatalogRows.map((r) => r.scryfallId.toLowerCase()),
  );
  for (const id of uniqueScryfallIds) {
    if (!foundSet.has(id.toLowerCase())) {
      throw new TriageValidationError(
        `Card scryfallId "${id}" does not exist in card_catalog.`,
        400,
      );
    }
  }

  return sanitized;
}

function buildSavedLotListItem(
  lot: CollectionLot,
  items: readonly LotItem[],
): SavedLotListItem {
  const bucketCardCounts: Record<AssignedBucket, number> = {
    PILE_1_BUYLIST: 0,
    PILE_2_SINGLES: 0,
    PILE_3_CREDIT_ARB: 0,
    PILE_4_BULK: 0,
  };
  let allocatedBasisSumCents = 0n;

  for (const item of items) {
    bucketCardCounts[item.assignedBucket] =
      (bucketCardCounts[item.assignedBucket] ?? 0) + item.quantity;
    allocatedBasisSumCents += parseUsdToCents(item.allocatedCostBasisUsd) ?? 0n;
  }

  const purchaseCents = parseUsdToCents(lot.purchaseCostUsd) ?? 0n;
  const realizedCents = parseUsdToCents(lot.actualRealizedPayoutUsd);
  const realizedProfitUsd =
    realizedCents !== null
      ? formatCentsToUsd(realizedCents - purchaseCents)
      : null;

  return {
    lotId: lot.lotId,
    lotName: lot.lotName,
    purchaseDate: lot.purchaseDate,
    purchaseCostUsd: formatCentsToUsd(purchaseCents),
    totalCards: lot.totalCards,
    lineItemCount: items.length,
    status: lot.status,
    estimatedGrossValueUsd: lot.estimatedGrossValueUsd,
    estimatedNetPayoutUsd: lot.estimatedNetPayoutUsd,
    actualRealizedPayoutUsd:
      realizedCents !== null ? formatCentsToUsd(realizedCents) : null,
    realizedProfitUsd,
    allocatedCostBasisSumUsd: formatCentsToUsd(allocatedBasisSumCents),
    bucketCardCounts,
    createdAt:
      lot.createdAt instanceof Date
        ? lot.createdAt.toISOString()
        : String(lot.createdAt),
  };
}

export async function createPersistedLot(
  db: Database,
  params: {
    lotName: unknown;
    purchaseCostUsd?: unknown;
    purchaseDate?: unknown;
    status?: unknown;
    actualRealizedPayoutUsd?: unknown;
    csvText?: unknown;
    inputs?: unknown;
    profile?: Partial<SerializedRoutingProfile> | Record<string, unknown>;
    buylistCashMode?: unknown;
    persistProfile?: unknown;
    userId?: string;
    now?: Date;
  },
): Promise<SavedLotDetailResponse> {
  const userId = params.userId ?? DEMO_USER_ID;
  const now = params.now ?? new Date();
  const lotName =
    typeof params.lotName === "string" ? params.lotName.trim() : "";
  if (!lotName) {
    throw new TriageValidationError("lotName is required.", 400);
  }
  if (lotName.length > 240) {
    throw new TriageValidationError(
      "lotName must be 240 characters or fewer.",
      400,
    );
  }

  const purchaseCostUsd =
    normalizeNonNegativeUsdField(
      params.purchaseCostUsd ?? "0.00",
      "purchaseCostUsd",
      { allowEmptyAsZero: true },
    ) ?? "0.00";
  const purchaseDate = validatePurchaseDate(params.purchaseDate);
  const status = validateLotStatus(params.status ?? "triaged");
  const buylistCashMode = validateBuylistCashMode(params.buylistCashMode);
  const actualRealizedPayoutUsd = normalizeOptionalNullableUsd(
    params.actualRealizedPayoutUsd,
    "actualRealizedPayoutUsd",
  );

  if (
    params.persistProfile !== undefined &&
    typeof params.persistProfile !== "boolean"
  ) {
    throw new TriageValidationError("persistProfile must be a boolean.", 400);
  }

  const effectiveProfile =
    params.persistProfile === true
      ? await upsertUserRoutingProfile(db, params.profile ?? {}, userId)
      : resolveRoutingProfile({
          ...(await getOrCreateUserRoutingProfile(db, userId)),
          ...sanitizeProfilePatch(params.profile),
        });

  let serializedInputs: SerializedRoutingCardInput[] = [];
  if (params.inputs !== undefined && params.inputs !== null) {
    serializedInputs = await validateAndSanitizeSerializedInputs(
      db,
      params.inputs,
    );
  } else if (typeof params.csvText === "string" && params.csvText.trim() !== "") {
    const ingested = await ingestAndRouteScannerCsv(db, {
      csvText: params.csvText,
      purchaseCostUsd,
      profile: serializeRoutingProfile(effectiveProfile),
      buylistCashMode,
      userId,
      now,
    });
    serializedInputs = ingested.inputs;
  } else {
    throw new TriageValidationError(
      "Either resolved routing inputs or scanner csvText must be provided to save a lot.",
      400,
    );
  }

  if (serializedInputs.length === 0) {
    throw new TriageValidationError(
      "Cannot persist an empty lot with 0 resolved cards.",
      400,
    );
  }

  const routingInputs = hydrateRoutingCardInputs(serializedInputs);
  const routed = routeCollectionLot({
    purchaseCostUsd,
    items: routingInputs,
    profile: effectiveProfile,
    options: { now, buylistCashMode },
  });
  assertSummaryFitsNumeric10_2(routed.summary);

  const orderedItemIds = generateOrderedLotItemIds(routed.items.length);

  const { insertedLot, insertedItems } = await db.transaction(async (tx) => {
    const [lot] = await tx
      .insert(collectionLots)
      .values({
        userId,
        lotName,
        ...(purchaseDate ? { purchaseDate } : {}),
        purchaseCostUsd: routed.summary.purchaseCostUsd,
        totalCards: routed.summary.totalCards,
        status,
        estimatedGrossValueUsd: routed.summary.estimatedGrossValueUsd,
        estimatedNetPayoutUsd: routed.summary.estimatedNetPayoutUsd,
        actualRealizedPayoutUsd,
      })
      .returning();

    if (!lot) {
      throw new Error("Failed to insert collection_lots row.");
    }

    const newItemRows = routed.toNewLotItems(lot.lotId).map((row, idx) => ({
      ...row,
      itemId: orderedItemIds[idx]!,
    }));
    const items = await tx.insert(lotItems).values(newItemRows).returning();

    return { insertedLot: lot, insertedItems: items };
  });

  const lockedSerializedInputs: SerializedRoutingCardInput[] =
    serializedInputs.map((input, idx) => ({
      ...input,
      lockedAllocatedCostBasisUsd:
        routed.items[idx]?.allocatedCostBasisUsd ??
        input.lockedAllocatedCostBasisUsd ??
        null,
    }));

  return {
    lot: buildSavedLotListItem(insertedLot, insertedItems),
    inputs: lockedSerializedInputs,
    profile: serializeRoutingProfile(effectiveProfile),
    buylistCashMode,
    evaluatedAt: now.toISOString(),
    summary: {
      ...serializeRoutedSummary(routed.summary),
      status: insertedLot.status,
    },
  };
}

export async function listPersistedLots(
  db: Database,
  userId: string = DEMO_USER_ID,
): Promise<SavedLotListItem[]> {
  const lots = await db
    .select()
    .from(collectionLots)
    .where(eq(collectionLots.userId, userId))
    .orderBy(desc(collectionLots.createdAt));

  if (lots.length === 0) {
    return [];
  }

  const lotIds = lots.map((l) => l.lotId);
  const allItems = await db
    .select()
    .from(lotItems)
    .where(inArray(lotItems.lotId, lotIds))
    .orderBy(asc(lotItems.itemId));

  const itemsByLot = new Map<string, LotItem[]>();
  for (const item of allItems) {
    const arr = itemsByLot.get(item.lotId) ?? [];
    arr.push(item);
    itemsByLot.set(item.lotId, arr);
  }

  return lots.map((lot) =>
    buildSavedLotListItem(lot, itemsByLot.get(lot.lotId) ?? []),
  );
}

async function reconstructSerializedInputsForLotItems(
  db: Database,
  items: readonly LotItem[],
  now: Date = new Date(),
): Promise<SerializedRoutingCardInput[]> {
  const scryfallIds = [
    ...new Set(
      items
        .map((i) => i.scryfallId)
        .filter((id): id is string => id !== null),
    ),
  ];

  if (scryfallIds.length === 0) {
    return [];
  }

  const catalogRows = await db
    .select()
    .from(cardCatalog)
    .where(inArray(cardCatalog.scryfallId, scryfallIds));
  const byScryfall = new Map<string, CardCatalogItem>(
    catalogRows.map((c) => [c.scryfallId.toLowerCase(), c]),
  );

  const pseudoResolved = items
    .map((item) => {
      if (!item.scryfallId) return null;
      const card = byScryfall.get(item.scryfallId.toLowerCase());
      if (!card) return null;
      return {
        persistedItem: item,
        parsedRow: {
          rowNumber: 1,
          format: "manabox" as const,
          cardName: card.name,
          scryfallId: card.scryfallId,
          tcgplayerProductId: card.tcgplayerId,
          setCode: card.setCode,
          setName: card.setName,
          collectorNumber: card.collectorNumber,
          finish: item.finish,
          condition: item.condition,
          language: item.language,
          isAltered: item.isAltered,
          isMisprint: item.isMisprint,
          quantity: item.quantity,
          rawRow: {},
        },
        card,
        effectiveFinish: item.finish,
        matchedBy: "scryfall_id" as const,
        finishListedInCatalog: true,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const skuMap = await fetchFreshSkuPriceCacheMap(db, pseudoResolved, now);

  return pseudoResolved.map((resolved) => {
    const key = makeSkuPriceCacheKey(
      resolved.card.scryfallId,
      resolved.effectiveFinish,
      resolved.parsedRow.condition,
    );
    return {
      card: resolved.card,
      finish: resolved.effectiveFinish,
      condition: resolved.parsedRow.condition,
      quantity: resolved.parsedRow.quantity,
      language: resolved.parsedRow.language,
      isAltered: resolved.parsedRow.isAltered,
      isMisprint: resolved.parsedRow.isMisprint,
      matchedBy: "persisted_lot",
      finishListedInCatalog: true,
      skuPriceCache: serializeSkuCache(skuMap.get(key) ?? null),
      lockedAllocatedCostBasisUsd:
        resolved.persistedItem.allocatedCostBasisUsd ?? null,
    };
  });
}

/**
 * Infers the per-lot routing profile & `buylistCashMode` from persisted `lot_items`
 * so reloading a lot saved with `persistProfile: false` (or `buylistCashMode: "conduit"`)
 * reproduces the lot's routing state even if global `user_routing_profiles` later changed.
 */
function inferLotRoutingContext(
  persistedItems: readonly LotItem[],
  serializedInputs: readonly SerializedRoutingCardInput[],
  storedProfile: RoutingProfileConfig,
  purchaseCostUsd: string,
  now: Date,
): {
  profile: RoutingProfileConfig;
  buylistCashMode: BuylistCashSelectionMode;
} {
  let conduitTierPreference = storedProfile.conduitTierPreference;
  let buylistCashMode: BuylistCashSelectionMode = "best";

  for (const item of persistedItems) {
    if (item.recommendedChannel === "conduit_sorted") {
      conduitTierPreference = "sorted";
    } else if (item.recommendedChannel === "conduit_standard") {
      conduitTierPreference = "standard";
    } else if (item.recommendedChannel === "conduit_curated") {
      conduitTierPreference = "curated";
    }

    if (item.assignedBucket === "PILE_1_BUYLIST") {
      const ckCashCents = parseUsdToCents(item.netCkCash) ?? 0n;
      const optCents = parseUsdToCents(item.optimalUnitNetUsd) ?? 0n;
      const conduitCuratedCents = parseUsdToCents(item.netConduitCurated) ?? 0n;
      if (
        item.recommendedChannel.startsWith("conduit_") &&
        ckCashCents >= optCents
      ) {
        buylistCashMode = "conduit";
      } else if (
        item.recommendedChannel === "ck_cash" &&
        conduitCuratedCents > ckCashCents
      ) {
        buylistCashMode = "ck_direct";
      }
    }
  }

  const hydratedInputs = hydrateRoutingCardInputs(serializedInputs);
  let hourlyLaborRateUsd = storedProfile.hourlyLaborRateUsd;

  // Infer hourlyLaborRateUsd from an uncached item's persisted net_tcgplayer_single if global rate changed
  if (storedProfile.secondsPerSingleOrder > 0) {
    for (
      let idx = 0;
      idx < persistedItems.length && idx < hydratedInputs.length;
      idx += 1
    ) {
      const persisted = persistedItems[idx]!;
      const cardInput = hydratedInputs[idx]!;
      if (cardInput.skuPriceCache || persisted.netTcgplayerSingle === null) {
        continue;
      }
      const persistedTcgCents = parseUsdToCents(persisted.netTcgplayerSingle);
      if (persistedTcgCents === null) continue;

      const withStoredRate = evaluateCardRouting(cardInput, storedProfile, {
        now,
        buylistCashMode,
      });
      if (withStoredRate.baselines.pRetailTcgCents <= 0n) {
        continue;
      }
      if (withStoredRate.nets.netTcgplayerSingleCents !== persistedTcgCents) {
        const zeroLaborEval = evaluateCardRouting(
          cardInput,
          { ...storedProfile, hourlyLaborRateUsd: "0.00" },
          { now, buylistCashMode },
        );
        const impliedLaborCents =
          zeroLaborEval.nets.netTcgplayerSingleCents - persistedTcgCents;
        if (impliedLaborCents >= 0n) {
          const inferredHourlyCents = divRoundHalfUp(
            impliedLaborCents * 3600n,
            BigInt(storedProfile.secondsPerSingleOrder),
          );
          if (inferredHourlyCents <= MAX_NUMERIC_10_2_CENTS) {
            hourlyLaborRateUsd = formatCentsToUsd(inferredHourlyCents);
          }
        }
      }
      break;
    }
  }

  let enableCreditArbitrage = storedProfile.enableCreditArbitrage;
  const hasPersistedCreditArb = persistedItems.some(
    (i) => i.assignedBucket === "PILE_3_CREDIT_ARB",
  );
  if (hasPersistedCreditArb) {
    enableCreditArbitrage = true;
  } else if (enableCreditArbitrage && hydratedInputs.length > 0) {
    const testRouted = routeCollectionLot({
      purchaseCostUsd,
      items: hydratedInputs,
      profile: {
        ...storedProfile,
        hourlyLaborRateUsd,
        conduitTierPreference,
        enableCreditArbitrage: true,
      },
      options: { now, buylistCashMode },
    });
    if (testRouted.summary.buckets.PILE_3_CREDIT_ARB.totalCards > 0) {
      enableCreditArbitrage = false;
    }
  }

  return {
    profile: resolveRoutingProfile({
      ...storedProfile,
      hourlyLaborRateUsd,
      conduitTierPreference,
      enableCreditArbitrage,
    }),
    buylistCashMode,
  };
}

export async function getPersistedLotById(
  db: Database,
  rawLotId: string,
  now: Date = new Date(),
): Promise<SavedLotDetailResponse> {
  const lotId = assertValidUuid(rawLotId, "lotId");

  const [lot] = await db
    .select()
    .from(collectionLots)
    .where(eq(collectionLots.lotId, lotId));

  if (!lot) {
    throw new TriageValidationError(`Lot not found: ${lotId}`, 404);
  }

  const items = await db
    .select()
    .from(lotItems)
    .where(eq(lotItems.lotId, lotId))
    .orderBy(asc(lotItems.itemId));

  const storedProfile = await getOrCreateUserRoutingProfile(db, lot.userId);
  const serializedInputs = await reconstructSerializedInputsForLotItems(
    db,
    items,
    now,
  );

  const inferred = inferLotRoutingContext(
    items,
    serializedInputs,
    storedProfile,
    lot.purchaseCostUsd,
    now,
  );

  const routed = routeCollectionLot({
    purchaseCostUsd: lot.purchaseCostUsd,
    items: hydrateRoutingCardInputs(serializedInputs),
    profile: inferred.profile,
    options: { now, buylistCashMode: inferred.buylistCashMode },
  });

  return {
    lot: buildSavedLotListItem(lot, items),
    inputs: serializedInputs,
    profile: serializeRoutingProfile(inferred.profile),
    buylistCashMode: inferred.buylistCashMode,
    evaluatedAt: now.toISOString(),
    summary: {
      ...serializeRoutedSummary(routed.summary),
      status: lot.status,
    },
  };
}

export async function updatePersistedLot(
  db: Database,
  rawLotId: string,
  patch: {
    lotName?: unknown;
    purchaseCostUsd?: unknown;
    status?: unknown;
    actualRealizedPayoutUsd?: unknown;
    profile?: Partial<SerializedRoutingProfile> | Record<string, unknown>;
    buylistCashMode?: unknown;
    persistProfile?: unknown;
    rerouteItems?: unknown;
    now?: Date;
  },
): Promise<SavedLotDetailResponse> {
  const lotId = assertValidUuid(rawLotId, "lotId");
  const now = patch.now ?? new Date();

  const [existingLot] = await db
    .select()
    .from(collectionLots)
    .where(eq(collectionLots.lotId, lotId));

  if (!existingLot) {
    throw new TriageValidationError(`Lot not found: ${lotId}`, 404);
  }

  if (
    patch.persistProfile !== undefined &&
    typeof patch.persistProfile !== "boolean"
  ) {
    throw new TriageValidationError("persistProfile must be a boolean.", 400);
  }
  if (
    patch.rerouteItems !== undefined &&
    typeof patch.rerouteItems !== "boolean"
  ) {
    throw new TriageValidationError("rerouteItems must be a boolean.", 400);
  }

  let nextLotName = existingLot.lotName;
  if (patch.lotName !== undefined) {
    if (typeof patch.lotName !== "string" || patch.lotName.trim() === "") {
      throw new TriageValidationError("lotName cannot be empty.", 400);
    }
    if (patch.lotName.trim().length > 240) {
      throw new TriageValidationError(
        "lotName must be 240 characters or fewer.",
        400,
      );
    }
    nextLotName = patch.lotName.trim();
  }

  const nextPurchaseCostUsd =
    patch.purchaseCostUsd !== undefined
      ? (normalizeNonNegativeUsdField(
          patch.purchaseCostUsd,
          "purchaseCostUsd",
          { allowEmptyAsZero: true },
        ) ?? existingLot.purchaseCostUsd)
      : existingLot.purchaseCostUsd;

  const nextStatus =
    patch.status !== undefined
      ? validateLotStatus(patch.status)
      : existingLot.status;

  let nextRealizedPayoutUsd = existingLot.actualRealizedPayoutUsd;
  if (patch.actualRealizedPayoutUsd !== undefined) {
    nextRealizedPayoutUsd = normalizeOptionalNullableUsd(
      patch.actualRealizedPayoutUsd,
      "actualRealizedPayoutUsd",
    );
  }

  const existingItems = await db
    .select()
    .from(lotItems)
    .where(eq(lotItems.lotId, lotId))
    .orderBy(asc(lotItems.itemId));

  const serializedInputs = await reconstructSerializedInputsForLotItems(
    db,
    existingItems,
    now,
  );

  const storedProfile = await getOrCreateUserRoutingProfile(
    db,
    existingLot.userId,
  );
  const inferredContext = inferLotRoutingContext(
    existingItems,
    serializedInputs,
    storedProfile,
    existingLot.purchaseCostUsd,
    now,
  );

  const sanitizedProfilePatch = sanitizeProfilePatch(patch.profile);
  const updatedProfile =
    patch.persistProfile === true
      ? await upsertUserRoutingProfile(
          db,
          {
            ...serializeRoutingProfile(inferredContext.profile),
            ...sanitizedProfilePatch,
          },
          existingLot.userId,
        )
      : resolveRoutingProfile({
          ...inferredContext.profile,
          ...sanitizedProfilePatch,
        });

  const effectiveBuylistCashMode =
    patch.buylistCashMode !== undefined
      ? validateBuylistCashMode(patch.buylistCashMode)
      : inferredContext.buylistCashMode;

  const shouldReroute =
    patch.rerouteItems === true ||
    patch.purchaseCostUsd !== undefined ||
    patch.profile !== undefined ||
    patch.buylistCashMode !== undefined;

  const routed = routeCollectionLot({
    purchaseCostUsd: nextPurchaseCostUsd,
    items: hydrateRoutingCardInputs(serializedInputs),
    profile: updatedProfile,
    options: { now, buylistCashMode: effectiveBuylistCashMode },
  });
  assertSummaryFitsNumeric10_2(routed.summary);

  const orderedItemIds = generateOrderedLotItemIds(routed.items.length);

  const { savedLot, savedItems } = await db.transaction(async (tx) => {
    const [updatedLot] = await tx
      .update(collectionLots)
      .set({
        lotName: nextLotName,
        purchaseCostUsd: nextPurchaseCostUsd,
        status: nextStatus,
        actualRealizedPayoutUsd: nextRealizedPayoutUsd,
        ...(shouldReroute
          ? {
              totalCards: routed.summary.totalCards,
              estimatedGrossValueUsd: routed.summary.estimatedGrossValueUsd,
              estimatedNetPayoutUsd: routed.summary.estimatedNetPayoutUsd,
            }
          : {}),
      })
      .where(eq(collectionLots.lotId, lotId))
      .returning();

    if (!updatedLot) {
      throw new Error(`Failed to update lot ${lotId}`);
    }

    if (!shouldReroute || serializedInputs.length === 0) {
      return { savedLot: updatedLot, savedItems: existingItems };
    }

    await tx.delete(lotItems).where(eq(lotItems.lotId, lotId));
    const freshItemRows = routed.toNewLotItems(lotId).map((row, idx) => ({
      ...row,
      itemId: orderedItemIds[idx]!,
    }));
    const freshItems = await tx
      .insert(lotItems)
      .values(freshItemRows)
      .returning();

    return { savedLot: updatedLot, savedItems: freshItems };
  });

  const finalSerializedInputs: SerializedRoutingCardInput[] =
    serializedInputs.map((input, idx) => ({
      ...input,
      lockedAllocatedCostBasisUsd:
        savedItems[idx]?.allocatedCostBasisUsd ??
        routed.items[idx]?.allocatedCostBasisUsd ??
        input.lockedAllocatedCostBasisUsd ??
        null,
    }));

  return {
    lot: buildSavedLotListItem(savedLot, savedItems),
    inputs: finalSerializedInputs,
    profile: serializeRoutingProfile(updatedProfile),
    buylistCashMode: effectiveBuylistCashMode,
    evaluatedAt: now.toISOString(),
    summary: {
      ...serializeRoutedSummary(routed.summary),
      status: savedLot.status,
    },
  };
}

export async function deletePersistedLot(
  db: Database,
  rawLotId: string,
): Promise<{ deleted: boolean; lotId: string }> {
  const lotId = assertValidUuid(rawLotId, "lotId");

  const deletedRows = await db
    .delete(collectionLots)
    .where(eq(collectionLots.lotId, lotId))
    .returning({ lotId: collectionLots.lotId });

  if (deletedRows.length === 0) {
    throw new TriageValidationError(`Lot not found: ${lotId}`, 404);
  }
  return { deleted: true, lotId };
}
