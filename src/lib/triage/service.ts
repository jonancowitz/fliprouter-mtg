import { desc, eq, inArray } from "drizzle-orm";
import { DEMO_USER_ID } from "@/db/demo-cards";
import type { Database } from "@/db/index";
import {
  type AssignedBucket,
  COLLECTION_LOT_STATUSES,
  type CardCatalogItem,
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
import {
  fetchFreshSkuPriceCacheMap,
  makeSkuPriceCacheKey,
  parseScannerCsv,
  resolveParsedCsvRows,
  type ScannerFormat,
} from "@/lib/csv";
import {
  DEFAULT_ROUTING_PROFILE,
  divRoundHalfUp,
  evaluatePaidSkuApiEligibility,
  formatBasisPointsToPercent,
  formatCentsToUsd,
  isFreshSkuPriceCache,
  parseRequiredUsdToCents,
  parseUsdToCents,
  type PaidSkuApiSkipReason,
  type RoutedLotSummary,
  type RoutingProfileConfig,
  resolveRoutingProfile,
  routeCollectionLot,
} from "@/lib/routing";
import {
  hydrateRoutingCardInputs,
  hydrateRoutingProfile,
  type SavedLotDetailResponse,
  type SavedLotListItem,
  type SerializedRoutedSummary,
  type SerializedRoutingCardInput,
  type SerializedRoutingProfile,
  serializeRoutingProfile,
  serializeSkuCache,
  type TriageDiagnostics,
  type TriageIngestResponse,
} from "./types";

export class TriageValidationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "TriageValidationError";
    this.statusCode = statusCode;
  }
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

function normalizeNonNegativeUsdField(
  raw: string | undefined,
  fieldName: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const cents = parseRequiredUsdToCents(raw, fieldName);
  if (cents < 0n) {
    throw new TriageValidationError(`${fieldName} cannot be negative.`);
  }
  return formatCentsToUsd(cents);
}

export function sanitizeProfilePatch(
  rawPatch?: Partial<SerializedRoutingProfile>,
): Partial<RoutingProfileConfig> {
  if (!rawPatch) return {};
  const hydrated = hydrateRoutingProfile(rawPatch);
  const out: Partial<RoutingProfileConfig> = {};

  const labor = normalizeNonNegativeUsdField(
    hydrated.hourlyLaborRateUsd,
    "hourlyLaborRateUsd",
  );
  if (labor !== undefined) out.hourlyLaborRateUsd = labor;

  if (hydrated.secondsPerSingleOrder !== undefined) {
    const secs = Number(hydrated.secondsPerSingleOrder);
    if (!Number.isInteger(secs) || secs < 0 || secs > 3600) {
      throw new TriageValidationError(
        "secondsPerSingleOrder must be an integer between 0 and 3600.",
      );
    }
    out.secondsPerSingleOrder = secs;
  }

  const pwe = normalizeNonNegativeUsdField(
    hydrated.pweShippingCostUsd,
    "pweShippingCostUsd",
  );
  if (pwe !== undefined) out.pweShippingCostUsd = pwe;

  const tracked = normalizeNonNegativeUsdField(
    hydrated.trackedShippingCostUsd,
    "trackedShippingCostUsd",
  );
  if (tracked !== undefined) out.trackedShippingCostUsd = tracked;

  const threshold = normalizeNonNegativeUsdField(
    hydrated.trackedThresholdUsd,
    "trackedThresholdUsd",
  );
  if (threshold !== undefined) out.trackedThresholdUsd = threshold;

  const boxShip = normalizeNonNegativeUsdField(
    hydrated.outboundBuylistBoxShippingUsd,
    "outboundBuylistBoxShippingUsd",
  );
  if (boxShip !== undefined) out.outboundBuylistBoxShippingUsd = boxShip;

  const minGain = normalizeNonNegativeUsdField(
    hydrated.minSingleNetGainOverBuylistUsd,
    "minSingleNetGainOverBuylistUsd",
  );
  if (minGain !== undefined) out.minSingleNetGainOverBuylistUsd = minGain;

  if (hydrated.enableCreditArbitrage !== undefined) {
    out.enableCreditArbitrage = Boolean(hydrated.enableCreditArbitrage);
  }

  if (hydrated.conduitTierPreference !== undefined) {
    if (
      !CONDUIT_TIERS.includes(
        hydrated.conduitTierPreference as ConduitTierPreference,
      )
    ) {
      throw new TriageValidationError(
        `Invalid conduitTierPreference: "${String(hydrated.conduitTierPreference)}"`,
      );
    }
    out.conduitTierPreference = hydrated.conduitTierPreference;
  }

  if (hydrated.monthlySkuApiQuota !== undefined) {
    const quota = Number(hydrated.monthlySkuApiQuota);
    if (!Number.isInteger(quota) || quota < 0) {
      throw new TriageValidationError(
        "monthlySkuApiQuota must be a non-negative integer.",
      );
    }
    out.monthlySkuApiQuota = quota;
  }

  if (hydrated.monthlySkuApiUsed !== undefined) {
    const used = Number(hydrated.monthlySkuApiUsed);
    if (!Number.isInteger(used) || used < 0) {
      throw new TriageValidationError(
        "monthlySkuApiUsed must be a non-negative integer.",
      );
    }
    out.monthlySkuApiUsed = used;
  }

  if (hydrated.skuApiQuotaResetAt !== undefined) {
    out.skuApiQuotaResetAt = hydrated.skuApiQuotaResetAt;
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
  patch: Partial<SerializedRoutingProfile>,
  userId: string = DEMO_USER_ID,
): Promise<RoutingProfileConfig> {
  const current = await getOrCreateUserRoutingProfile(db, userId);
  const sanitized = sanitizeProfilePatch(patch);
  const merged = resolveRoutingProfile({ ...current, ...sanitized });

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
      },
    })
    .returning();

  return updated ?? merged;
}

export async function ingestAndRouteScannerCsv(
  db: Database,
  params: {
    csvText: string;
    format?: ScannerFormat;
    purchaseCostUsd?: string;
    profile?: Partial<SerializedRoutingProfile>;
    userId?: string;
    now?: Date;
  },
): Promise<TriageIngestResponse> {
  const now = params.now ?? new Date();
  const userId = params.userId ?? DEMO_USER_ID;

  if (!params.csvText || params.csvText.trim() === "") {
    throw new TriageValidationError("Scanner CSV text is required.");
  }

  const storedProfile = await getOrCreateUserRoutingProfile(db, userId);
  const effectiveProfile = resolveRoutingProfile({
    ...storedProfile,
    ...sanitizeProfilePatch(params.profile),
  });

  const purchaseCostUsd =
    normalizeNonNegativeUsdField(
      params.purchaseCostUsd ?? "0.00",
      "purchaseCostUsd",
    ) ?? "0.00";

  const parsed = parseScannerCsv(params.csvText, { format: params.format });
  const resolution = await resolveParsedCsvRows(parsed.rows, db);
  const skuCacheMap = await fetchFreshSkuPriceCacheMap(
    db,
    resolution.resolved,
    now,
  );

  const matchStrategyCounts: TriageDiagnostics["matchStrategyCounts"] = {};
  const skipReasons: Partial<Record<PaidSkuApiSkipReason, number>> = {};
  let freshSkuCacheHitCount = 0;
  let proSkuApiEligibleCount = 0;

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
        effectiveProfile,
        { now },
      );

      if (eligibility.eligible) {
        proSkuApiEligibleCount += 1;
      } else if (eligibility.skipReason) {
        skipReasons[eligibility.skipReason] =
          (skipReasons[eligibility.skipReason] ?? 0) + 1;
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
    options: { now },
  });

  const diagnostics: TriageDiagnostics = {
    scannerFormat: parsed.format,
    headers: parsed.headers,
    totalParsedRows: parsed.rows.length,
    totalResolvedRows: resolution.stats.resolvedRows,
    totalResolvedCards: resolution.stats.totalResolvedCards,
    unresolvedRowCount: resolution.stats.unresolvedRows,
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
  };

  return {
    diagnostics,
    inputs: serializedInputs,
    profile: serializeRoutingProfile(effectiveProfile),
    summary: serializeRoutedSummary(routed.summary),
  };
}

function validateLotStatus(raw: string | undefined): CollectionLotStatus {
  if (!raw) return "triaged";
  if (!COLLECTION_LOT_STATUSES.includes(raw as CollectionLotStatus)) {
    throw new TriageValidationError(
      `Invalid lot status "${raw}". Expected one of: ${COLLECTION_LOT_STATUSES.join(", ")}.`,
    );
  }
  return raw as CollectionLotStatus;
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
    lotName: string;
    purchaseCostUsd: string;
    purchaseDate?: string;
    status?: CollectionLotStatus;
    actualRealizedPayoutUsd?: string | null;
    csvText?: string;
    inputs?: SerializedRoutingCardInput[];
    profile?: Partial<SerializedRoutingProfile>;
    persistProfile?: boolean;
    userId?: string;
    now?: Date;
  },
): Promise<SavedLotDetailResponse> {
  const userId = params.userId ?? DEMO_USER_ID;
  const now = params.now ?? new Date();
  const lotName = params.lotName?.trim();
  if (!lotName) {
    throw new TriageValidationError("lotName is required.");
  }

  const purchaseCostUsd =
    normalizeNonNegativeUsdField(params.purchaseCostUsd, "purchaseCostUsd") ??
    "0.00";
  const status = validateLotStatus(params.status ?? "triaged");

  let actualRealizedPayoutUsd: string | null = null;
  if (
    params.actualRealizedPayoutUsd !== undefined &&
    params.actualRealizedPayoutUsd !== null &&
    params.actualRealizedPayoutUsd.trim() !== ""
  ) {
    actualRealizedPayoutUsd =
      normalizeNonNegativeUsdField(
        params.actualRealizedPayoutUsd,
        "actualRealizedPayoutUsd",
      ) ?? null;
  }

  const effectiveProfile = params.persistProfile
    ? await upsertUserRoutingProfile(db, params.profile ?? {}, userId)
    : resolveRoutingProfile({
        ...(await getOrCreateUserRoutingProfile(db, userId)),
        ...sanitizeProfilePatch(params.profile),
      });

  let serializedInputs: SerializedRoutingCardInput[] = [];
  if (params.inputs && params.inputs.length > 0) {
    serializedInputs = params.inputs;
  } else if (params.csvText && params.csvText.trim() !== "") {
    const ingested = await ingestAndRouteScannerCsv(db, {
      csvText: params.csvText,
      purchaseCostUsd,
      profile: serializeRoutingProfile(effectiveProfile),
      userId,
      now,
    });
    serializedInputs = ingested.inputs;
  } else {
    throw new TriageValidationError(
      "Either resolved routing inputs or scanner csvText must be provided to save a lot.",
    );
  }

  if (serializedInputs.length === 0) {
    throw new TriageValidationError(
      "Cannot persist an empty lot with 0 resolved cards.",
    );
  }

  const routingInputs = hydrateRoutingCardInputs(serializedInputs);
  const routed = routeCollectionLot({
    purchaseCostUsd,
    items: routingInputs,
    profile: effectiveProfile,
    options: { now },
  });

  const { insertedLot, insertedItems } = await db.transaction(async (tx) => {
    const [lot] = await tx
      .insert(collectionLots)
      .values({
        userId,
        lotName,
        ...(params.purchaseDate ? { purchaseDate: params.purchaseDate } : {}),
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

    const newItemRows = routed.toNewLotItems(lot.lotId);
    const items = await tx.insert(lotItems).values(newItemRows).returning();

    return { insertedLot: lot, insertedItems: items };
  });

  return {
    lot: buildSavedLotListItem(insertedLot, insertedItems),
    inputs: serializedInputs,
    profile: serializeRoutingProfile(effectiveProfile),
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
    .where(inArray(lotItems.lotId, lotIds));

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
    };
  });
}

export async function getPersistedLotById(
  db: Database,
  lotId: string,
  now: Date = new Date(),
): Promise<SavedLotDetailResponse> {
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
    .where(eq(lotItems.lotId, lotId));

  const profile = await getOrCreateUserRoutingProfile(db, lot.userId);
  const serializedInputs = await reconstructSerializedInputsForLotItems(
    db,
    items,
    now,
  );
  const routed = routeCollectionLot({
    purchaseCostUsd: lot.purchaseCostUsd,
    items: hydrateRoutingCardInputs(serializedInputs),
    profile,
    options: { now },
  });

  return {
    lot: buildSavedLotListItem(lot, items),
    inputs: serializedInputs,
    profile: serializeRoutingProfile(profile),
    summary: {
      ...serializeRoutedSummary(routed.summary),
      status: lot.status,
    },
  };
}

export async function updatePersistedLot(
  db: Database,
  lotId: string,
  patch: {
    lotName?: string;
    purchaseCostUsd?: string;
    status?: CollectionLotStatus;
    actualRealizedPayoutUsd?: string | null;
    profile?: Partial<SerializedRoutingProfile>;
    rerouteItems?: boolean;
    now?: Date;
  },
): Promise<SavedLotDetailResponse> {
  const now = patch.now ?? new Date();
  const [existingLot] = await db
    .select()
    .from(collectionLots)
    .where(eq(collectionLots.lotId, lotId));

  if (!existingLot) {
    throw new TriageValidationError(`Lot not found: ${lotId}`, 404);
  }

  const updatedProfile = patch.profile
    ? await upsertUserRoutingProfile(db, patch.profile, existingLot.userId)
    : await getOrCreateUserRoutingProfile(db, existingLot.userId);

  const nextLotName =
    patch.lotName !== undefined ? patch.lotName.trim() : existingLot.lotName;
  if (!nextLotName) {
    throw new TriageValidationError("lotName cannot be empty.");
  }

  const nextPurchaseCostUsd =
    patch.purchaseCostUsd !== undefined
      ? (normalizeNonNegativeUsdField(
          patch.purchaseCostUsd,
          "purchaseCostUsd",
        ) ?? existingLot.purchaseCostUsd)
      : existingLot.purchaseCostUsd;

  const nextStatus =
    patch.status !== undefined
      ? validateLotStatus(patch.status)
      : existingLot.status;

  let nextRealizedPayoutUsd = existingLot.actualRealizedPayoutUsd;
  if (patch.actualRealizedPayoutUsd !== undefined) {
    if (
      patch.actualRealizedPayoutUsd === null ||
      patch.actualRealizedPayoutUsd.trim() === ""
    ) {
      nextRealizedPayoutUsd = null;
    } else {
      nextRealizedPayoutUsd =
        normalizeNonNegativeUsdField(
          patch.actualRealizedPayoutUsd,
          "actualRealizedPayoutUsd",
        ) ?? null;
    }
  }

  const existingItems = await db
    .select()
    .from(lotItems)
    .where(eq(lotItems.lotId, lotId));

  const serializedInputs = await reconstructSerializedInputsForLotItems(
    db,
    existingItems,
    now,
  );

  const shouldReroute =
    patch.rerouteItems === true ||
    patch.purchaseCostUsd !== undefined ||
    patch.profile !== undefined;

  const routed = routeCollectionLot({
    purchaseCostUsd: nextPurchaseCostUsd,
    items: hydrateRoutingCardInputs(serializedInputs),
    profile: updatedProfile,
    options: { now },
  });

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
    const freshItems = await tx
      .insert(lotItems)
      .values(routed.toNewLotItems(lotId))
      .returning();

    return { savedLot: updatedLot, savedItems: freshItems };
  });

  return {
    lot: buildSavedLotListItem(savedLot, savedItems),
    inputs: serializedInputs,
    profile: serializeRoutingProfile(updatedProfile),
    summary: {
      ...serializeRoutedSummary(routed.summary),
      status: savedLot.status,
    },
  };
}

export async function deletePersistedLot(
  db: Database,
  lotId: string,
): Promise<{ deleted: boolean; lotId: string }> {
  const deletedRows = await db
    .delete(collectionLots)
    .where(eq(collectionLots.lotId, lotId))
    .returning({ lotId: collectionLots.lotId });

  if (deletedRows.length === 0) {
    throw new TriageValidationError(`Lot not found: ${lotId}`, 404);
  }
  return { deleted: true, lotId };
}
