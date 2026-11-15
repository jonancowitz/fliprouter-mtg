import type {
  AssignedBucket,
  CardCatalogItem,
  CardCondition,
  CardFinish,
  CollectionLotStatus,
  ConduitTierPreference,
  NewLotItem,
  RecommendedChannel,
  SkuPriceCacheItem,
  UserRoutingProfile,
} from "@/db/schema";

export type CatalogPriceFields = Pick<
  CardCatalogItem,
  | "scryfallId"
  | "name"
  | "setCode"
  | "setName"
  | "collectorNumber"
  | "rarity"
  | "finishes"
  | "tcgplayerId"
  | "tcgplayerEtchedId"
  | "cardkingdomId"
  | "cardkingdomFoilId"
  | "tcgMarketNm"
  | "tcgLowNm"
  | "tcgMarketFoil"
  | "tcgLowFoil"
  | "tcgMarketEtched"
  | "tcgLowEtched"
  | "manapoolLowNm"
  | "manapoolLowFoil"
  | "manapoolLowEtched"
  | "ckBuylistCashNm"
  | "ckBuylistCreditNm"
  | "ckBuylistCashFoil"
  | "ckBuylistCreditFoil"
  | "ckBuylistCashEtched"
  | "ckBuylistCreditEtched"
>;

export type SkuCacheFields = Pick<
  SkuPriceCacheItem,
  | "scryfallId"
  | "finish"
  | "condition"
  | "retailLowUsd"
  | "retailMarketUsd"
  | "buylistCashUsd"
  | "buylistCreditUsd"
  | "source"
  | "expiresAt"
>;

export type RoutingProfileConfig = Pick<
  UserRoutingProfile,
  | "hourlyLaborRateUsd"
  | "secondsPerSingleOrder"
  | "pweShippingCostUsd"
  | "trackedShippingCostUsd"
  | "trackedThresholdUsd"
  | "outboundBuylistBoxShippingUsd"
  | "minSingleNetGainOverBuylistUsd"
  | "enableCreditArbitrage"
  | "conduitTierPreference"
  | "monthlySkuApiQuota"
  | "monthlySkuApiUsed"
> & {
  skuApiQuotaResetAt?: Date;
};

export const DEFAULT_ROUTING_PROFILE: RoutingProfileConfig = {
  hourlyLaborRateUsd: "20.00",
  secondsPerSingleOrder: 180,
  pweShippingCostUsd: "0.90",
  trackedShippingCostUsd: "4.25",
  trackedThresholdUsd: "25.00",
  outboundBuylistBoxShippingUsd: "12.00",
  minSingleNetGainOverBuylistUsd: "1.25",
  enableCreditArbitrage: false,
  conduitTierPreference: "curated",
  monthlySkuApiQuota: 0,
  monthlySkuApiUsed: 0,
};

export type BuylistCashSelectionMode = "best" | "ck_direct" | "conduit";

export interface RoutingEngineOptions {
  /** Reference timestamp for 24h `sku_price_cache.expires_at` checks (defaults to `new Date()`). */
  now?: Date;
  /**
   * Controls how `Net_Buylist_Cash` selects between Card Kingdom Direct Cash
   * and Card Conduit's configured tier:
   * - `"best"` (default, `SPEC.md` §4.B.2): `max(Net_CK_Cash, Net_Conduit_Tier)`
   * - `"ck_direct"`: force Card Kingdom cash (`ck_cash`)
   * - `"conduit"`: force configured Card Conduit tier (`conduit_*`)
   */
  buylistCashMode?: BuylistCashSelectionMode;
}

export interface RoutingCardInput {
  card: CatalogPriceFields;
  finish?: CardFinish;
  condition?: CardCondition;
  quantity?: number;
  language?: string;
  isAltered?: boolean;
  isMisprint?: boolean;
  skuPriceCache?: SkuCacheFields | null;
  /**
   * Optional multi-vendor wholesale cash quote (USD) when evaluating Card Conduit
   * against a vendor pool distinct from Card Kingdom's local `ck_buylist_cash_*`.
   */
  conduitBuylistCashUsd?: string | null;
  /**
   * Optional acquisition-date locked Schedule C line-item cost basis (USD) loaded
   * from persisted `lot_items.allocated_cost_basis_usd`. Preserved across re-routes
   * whenever all lot items carry locked values summing cent-exact to `purchaseCostUsd`.
   */
  lockedAllocatedCostBasisUsd?: string | null;
}

export type QuarantineReason =
  | "damaged_condition"
  | "non_english_language"
  | "altered_card"
  | "misprint_card";

export interface QuarantineAssessment {
  isQuarantined: boolean;
  reasons: QuarantineReason[];
}

export type PaidSkuApiSkipReason =
  | "fresh_cache_hit"
  | "quota_exhausted"
  | "quarantined_item"
  | "near_mint_condition"
  | "below_nm_price_threshold";

export interface PaidSkuApiEligibility {
  eligible: boolean;
  nmBaselineUsd: string;
  nmBaselineCents: bigint;
  skipReason?: PaidSkuApiSkipReason;
}

export interface ResolvedChannelBaselines {
  usedFreshSkuCache: boolean;
  isQuarantined: boolean;
  quarantineReasons: QuarantineReason[];
  initialFmvCents: bigint;
  initialFmvUsd: string;
  pRetailTcgCents: bigint;
  pRetailTcgUsd: string;
  pRetailMpCents: bigint;
  pRetailMpUsd: string;
  pRetailP2pCents: bigint;
  pRetailP2pUsd: string;
  pSaleP2pClaimCents: bigint;
  pSaleP2pClaimUsd: string;
  pBuyCkCents: bigint;
  pBuyCkUsd: string;
  pBuyConduitCents: bigint;
  pBuyConduitUsd: string;
  ckStoreCreditRawCents: bigint;
  ckStoreCreditRawUsd: string;
}

export interface ComputedChannelNets {
  laborCostUsd: string;
  shipTcgUsd: string;
  shipMpUsd: string;
  shipP2pUsd: string;
  netTcgplayerSingleCents: bigint;
  netTcgplayerSingleUsd: string;
  netManapoolSingleCents: bigint;
  netManapoolSingleUsd: string;
  netP2p85PctCents: bigint;
  netP2p85PctUsd: string;
  netBestSingleCents: bigint;
  netBestSingleUsd: string;
  bestSingleChannel: "tcgplayer_single" | "manapool_single" | "p2p_85_pct";
  netCkCashCents: bigint;
  netCkCashUsd: string;
  netConduitSortedCents: bigint;
  netConduitSortedUsd: string;
  netConduitCuratedCents: bigint;
  netConduitCuratedUsd: string;
  netConduitStandardCents: bigint;
  netConduitStandardUsd: string;
  activeConduitChannel:
    | "conduit_sorted"
    | "conduit_curated"
    | "conduit_standard";
  netConduitActiveTierCents: bigint;
  netConduitActiveTierUsd: string;
  activeBuylistCashChannel:
    | "ck_cash"
    | "conduit_sorted"
    | "conduit_curated"
    | "conduit_standard";
  netBuylistCashCents: bigint;
  netBuylistCashUsd: string;
  netCkCreditCents: bigint;
  netCkCreditUsd: string;
}

export interface EvaluatedCardRouting {
  scryfallId: string;
  finish: CardFinish;
  condition: CardCondition;
  quantity: number;
  language: string;
  isAltered: boolean;
  isMisprint: boolean;
  baselines: ResolvedChannelBaselines;
  nets: ComputedChannelNets;
  assignedBucket: AssignedBucket;
  recommendedChannel: RecommendedChannel;
  optimalUnitNetCents: bigint;
  optimalUnitNetUsd: string;
  nonBuylistFallbackBucket: "PILE_2_SINGLES" | "PILE_4_BULK";
  nonBuylistFallbackChannel: RecommendedChannel;
  nonBuylistFallbackUnitNetCents: bigint;
  nonBuylistFallbackUnitNetUsd: string;
}

export type BuylistVendor = "card_kingdom" | "card_conduit";

export interface RoutedLotItem extends EvaluatedCardRouting {
  card: CatalogPriceFields;
  /** Line-item Schedule C allocated cost basis (`lot_items.allocated_cost_basis_usd`), summing cent-exact to `purchaseCostUsd`. */
  allocatedCostBasisCents: bigint;
  allocatedCostBasisUsd: string;
  /** Per-copy unit cost basis (`roundHalfUp(allocatedCostBasisCents / quantity)`). */
  unitAllocatedCostBasisCents: bigint;
  unitAllocatedCostBasisUsd: string;
  /** Alias for `allocatedCostBasisCents` / `allocatedCostBasisUsd` (line-item total cost basis). */
  totalAllocatedCostBasisCents: bigint;
  totalAllocatedCostBasisUsd: string;
  totalOptimalNetCents: bigint;
  totalOptimalNetUsd: string;
  demotedFromBuylistByPostageGuard: boolean;
  initialAssignedBucket: AssignedBucket;
  initialRecommendedChannel: RecommendedChannel;
}

export interface VendorBuylistShipmentSummary {
  vendor: BuylistVendor;
  totalCards: number;
  grossBuylistNetCents: bigint;
  grossBuylistNetUsd: string;
  fallbackNetCents: bigint;
  fallbackNetUsd: string;
  boxShippingCents: bigint;
  boxShippingUsd: string;
  demotedToNonBuylist: boolean;
}

export interface BucketSummaryMetrics {
  bucket: AssignedBucket;
  lineItemCount: number;
  totalCards: number;
  grossFmvUsd: string;
  optimalNetUsd: string;
}

export interface RoutedLotSummary {
  totalLineItems: number;
  totalCards: number;
  purchaseCostCents: bigint;
  purchaseCostUsd: string;
  allocatedCostBasisSumCents: bigint;
  allocatedCostBasisSumUsd: string;
  estimatedGrossValueCents: bigint;
  estimatedGrossValueUsd: string;
  subtotalItemNetPayoutCents: bigint;
  subtotalItemNetPayoutUsd: string;
  outboundBoxCount: number;
  outboundBoxShippingCents: bigint;
  outboundBoxShippingUsd: string;
  estimatedNetPayoutCents: bigint;
  estimatedNetPayoutUsd: string;
  estimatedNetProfitCents: bigint;
  estimatedNetProfitUsd: string;
  /** Signed percentage string to 2 decimal places (e.g. "38.71"), or `null` when `purchaseCostUsd == 0`. */
  estimatedNetRoiPct: string | null;
  status: CollectionLotStatus;
  vendorShipments: VendorBuylistShipmentSummary[];
  buckets: Record<AssignedBucket, BucketSummaryMetrics>;
}

export interface RouteCollectionLotInput {
  purchaseCostUsd: string;
  items: readonly RoutingCardInput[];
  profile?: Partial<RoutingProfileConfig>;
  options?: RoutingEngineOptions;
  lotId?: string;
}

export interface RouteCollectionLotResult {
  items: RoutedLotItem[];
  summary: RoutedLotSummary;
  /** Ready-to-insert Drizzle `lot_items` rows when `lotId` is supplied (or template rows with `lotId` placeholder). */
  toNewLotItems: (lotId: string) => NewLotItem[];
}

export type {
  AssignedBucket,
  CardCatalogItem,
  CardCondition,
  CardFinish,
  ConduitTierPreference,
  RecommendedChannel,
  SkuPriceCacheItem,
  UserRoutingProfile,
};
