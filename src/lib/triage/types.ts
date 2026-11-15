import type {
  AssignedBucket,
  CardCondition,
  CardFinish,
  CollectionLotStatus,
  ConduitTierPreference,
  RecommendedChannel,
  SkuPriceSource,
} from "@/db/schema";
import type {
  CatalogMatchStrategy,
  ScannerFormat,
  SkippedCsvRow,
  UnresolvedRowReason,
} from "@/lib/csv";
import type {
  BucketSummaryMetrics,
  BuylistVendor,
  CatalogPriceFields,
  PaidSkuApiSkipReason,
  RoutingCardInput,
  RoutingProfileConfig,
  SkuCacheFields,
} from "@/lib/routing";

export interface SerializedSkuCacheFields {
  scryfallId: string;
  finish: CardFinish;
  condition: CardCondition;
  retailLowUsd: string | null;
  retailMarketUsd: string | null;
  buylistCashUsd: string | null;
  buylistCreditUsd: string | null;
  source: SkuPriceSource;
  expiresAt: string;
}

export interface SerializedRoutingCardInput {
  card: CatalogPriceFields;
  finish: CardFinish;
  condition: CardCondition;
  quantity: number;
  language: string;
  isAltered: boolean;
  isMisprint: boolean;
  matchedBy?: CatalogMatchStrategy | "persisted_lot";
  finishListedInCatalog?: boolean;
  skuPriceCache: SerializedSkuCacheFields | null;
  conduitBuylistCashUsd?: string | null;
}

export interface UnresolvedRowSummary {
  rowNumber: number;
  reason: UnresolvedRowReason;
  cardName: string | null;
  setCode: string | null;
  collectorNumber: string | null;
  attemptedStrategies: string[];
}

export interface TriageDiagnostics {
  scannerFormat: ScannerFormat;
  headers: string[];
  totalParsedRows: number;
  totalResolvedRows: number;
  totalResolvedCards: number;
  unresolvedRowCount: number;
  skippedRowCount: number;
  localDbOnlyCount: number;
  freshSkuCacheHitCount: number;
  localDbCoveragePct: string;
  proSkuApiEligibleCount: number;
  proSkuApiSkipReasons: Partial<Record<PaidSkuApiSkipReason, number>>;
  matchStrategyCounts: Partial<Record<CatalogMatchStrategy, number>>;
  unresolvedRows: UnresolvedRowSummary[];
  skippedRows: SkippedCsvRow[];
}

export interface SerializedVendorShipment {
  vendor: BuylistVendor;
  totalCards: number;
  grossBuylistNetUsd: string;
  fallbackNetUsd: string;
  boxShippingUsd: string;
  demotedToNonBuylist: boolean;
}

export interface SerializedRoutedSummary {
  totalLineItems: number;
  totalCards: number;
  purchaseCostUsd: string;
  allocatedCostBasisSumUsd: string;
  estimatedGrossValueUsd: string;
  subtotalItemNetPayoutUsd: string;
  outboundBoxCount: number;
  outboundBoxShippingUsd: string;
  estimatedNetPayoutUsd: string;
  estimatedNetProfitUsd: string;
  estimatedNetRoiPct: string | null;
  status: CollectionLotStatus;
  vendorShipments: SerializedVendorShipment[];
  buckets: Record<AssignedBucket, BucketSummaryMetrics>;
}

export interface SerializedRoutingProfile {
  hourlyLaborRateUsd: string;
  secondsPerSingleOrder: number;
  pweShippingCostUsd: string;
  trackedShippingCostUsd: string;
  trackedThresholdUsd: string;
  outboundBuylistBoxShippingUsd: string;
  minSingleNetGainOverBuylistUsd: string;
  enableCreditArbitrage: boolean;
  conduitTierPreference: ConduitTierPreference;
  monthlySkuApiQuota: number;
  monthlySkuApiUsed: number;
  skuApiQuotaResetAt?: string;
}

export interface TriageIngestResponse {
  diagnostics: TriageDiagnostics;
  inputs: SerializedRoutingCardInput[];
  profile: SerializedRoutingProfile;
  summary: SerializedRoutedSummary;
}

export interface SavedLotListItem {
  lotId: string;
  lotName: string;
  purchaseDate: string;
  purchaseCostUsd: string;
  totalCards: number;
  lineItemCount: number;
  status: CollectionLotStatus;
  estimatedGrossValueUsd: string | null;
  estimatedNetPayoutUsd: string | null;
  actualRealizedPayoutUsd: string | null;
  realizedProfitUsd: string | null;
  allocatedCostBasisSumUsd: string;
  bucketCardCounts: Record<AssignedBucket, number>;
  createdAt: string;
}

export interface SavedLotDetailResponse {
  lot: SavedLotListItem;
  inputs: SerializedRoutingCardInput[];
  profile: SerializedRoutingProfile;
  summary: SerializedRoutedSummary;
}

export function serializeSkuCache(
  cache: SkuCacheFields | null | undefined,
): SerializedSkuCacheFields | null {
  if (!cache) return null;
  return {
    scryfallId: cache.scryfallId,
    finish: cache.finish,
    condition: cache.condition,
    retailLowUsd: cache.retailLowUsd,
    retailMarketUsd: cache.retailMarketUsd,
    buylistCashUsd: cache.buylistCashUsd,
    buylistCreditUsd: cache.buylistCreditUsd,
    source: cache.source,
    expiresAt:
      cache.expiresAt instanceof Date
        ? cache.expiresAt.toISOString()
        : String(cache.expiresAt),
  };
}

export function hydrateSkuCache(
  raw: SerializedSkuCacheFields | null | undefined,
): SkuCacheFields | null {
  if (!raw) return null;
  return {
    scryfallId: raw.scryfallId,
    finish: raw.finish,
    condition: raw.condition,
    retailLowUsd: raw.retailLowUsd,
    retailMarketUsd: raw.retailMarketUsd,
    buylistCashUsd: raw.buylistCashUsd,
    buylistCreditUsd: raw.buylistCreditUsd,
    source: raw.source,
    expiresAt: new Date(raw.expiresAt),
  };
}

export function hydrateRoutingCardInputs(
  serialized: readonly SerializedRoutingCardInput[],
): RoutingCardInput[] {
  return serialized.map((item) => ({
    card: item.card,
    finish: item.finish,
    condition: item.condition,
    quantity: item.quantity,
    language: item.language,
    isAltered: item.isAltered,
    isMisprint: item.isMisprint,
    skuPriceCache: hydrateSkuCache(item.skuPriceCache),
    conduitBuylistCashUsd: item.conduitBuylistCashUsd ?? null,
  }));
}

export function serializeRoutingProfile(
  profile: RoutingProfileConfig,
): SerializedRoutingProfile {
  return {
    hourlyLaborRateUsd: profile.hourlyLaborRateUsd,
    secondsPerSingleOrder: profile.secondsPerSingleOrder,
    pweShippingCostUsd: profile.pweShippingCostUsd,
    trackedShippingCostUsd: profile.trackedShippingCostUsd,
    trackedThresholdUsd: profile.trackedThresholdUsd,
    outboundBuylistBoxShippingUsd: profile.outboundBuylistBoxShippingUsd,
    minSingleNetGainOverBuylistUsd: profile.minSingleNetGainOverBuylistUsd,
    enableCreditArbitrage: profile.enableCreditArbitrage,
    conduitTierPreference: profile.conduitTierPreference,
    monthlySkuApiQuota: profile.monthlySkuApiQuota,
    monthlySkuApiUsed: profile.monthlySkuApiUsed,
    skuApiQuotaResetAt: profile.skuApiQuotaResetAt
      ? profile.skuApiQuotaResetAt.toISOString()
      : undefined,
  };
}

export function hydrateRoutingProfile(
  serialized: Partial<SerializedRoutingProfile> | undefined,
): Partial<RoutingProfileConfig> {
  if (!serialized) return {};
  const { skuApiQuotaResetAt, ...rest } = serialized;
  return {
    ...rest,
    ...(skuApiQuotaResetAt
      ? { skuApiQuotaResetAt: new Date(skuApiQuotaResetAt) }
      : {}),
  };
}

export type { AssignedBucket, CollectionLotStatus, RecommendedChannel };
