import type {
  AssignedBucket,
  CardCondition,
  CardFinish,
  ConduitTierPreference,
  NewLotItem,
  RecommendedChannel,
} from "@/db/schema";
import {
  addRational,
  allocateScheduleCCostBasis,
  coalescePositiveUsdToCents,
  divRoundHalfUp,
  formatBasisPointsToPercent,
  formatCentsToUsd,
  makeRational,
  maxCents,
  minRational,
  mulCentsByRatioHalfUp,
  mulRational,
  parseRequiredUsdToCents,
  parseUsdToCents,
  type RationalCents,
  rationalFromCents,
  roundRationalToCents,
  subRational,
} from "./money";
import {
  type BucketSummaryMetrics,
  type BuylistVendor,
  type CatalogPriceFields,
  type ComputedChannelNets,
  DEFAULT_ROUTING_PROFILE,
  type EvaluatedCardRouting,
  type PaidSkuApiEligibility,
  type QuarantineAssessment,
  type QuarantineReason,
  type ResolvedChannelBaselines,
  type RouteCollectionLotInput,
  type RouteCollectionLotResult,
  type RoutedLotItem,
  type RoutingCardInput,
  type RoutingEngineOptions,
  type RoutingProfileConfig,
  type SkuCacheFields,
  type VendorBuylistShipmentSummary,
} from "./types";

/** Retail condition multipliers (basis points out of 100): NM=1.00, LP=0.88, MP=0.72, HP=0.52, DMG=0.35 */
export const RETAIL_CONDITION_MULTIPLIER_PCT: Readonly<
  Record<CardCondition, bigint>
> = {
  NM: 100n,
  LP: 88n,
  MP: 72n,
  HP: 52n,
  DMG: 35n,
};

/** Wholesale buylist condition multipliers (basis points out of 100): NM=1.00, LP=0.80, MP=0.65, HP=0.50, DMG=0.00 */
export const BUYLIST_CONDITION_MULTIPLIER_PCT: Readonly<
  Record<CardCondition, bigint>
> = {
  NM: 100n,
  LP: 80n,
  MP: 65n,
  HP: 50n,
  DMG: 0n,
};

const NON_NM_FOIL_BUYLIST_WEAR_NUM = 90n;
const NON_NM_FOIL_BUYLIST_WEAR_DEN = 100n;

const PAID_SKU_API_NM_THRESHOLD_CENTS = 800n; // $8.00
const PAID_SKU_API_NON_NM_MIN_NM_CENTS = 100n; // $1.00 (skip sub-dollar bulk on LP/MP/HP)
const BUYLIST_MIN_ELIGIBLE_CENTS = 50n; // $0.50
const BULK_SINGLE_NET_FLOOR_CENTS = 75n; // $0.75
const BINDER_LOCAL_RETAIL_MIN_CENTS = 50n; // $0.50

const TCG_COMMISSION_RATE = makeRational(1075n, 10_000n); // 10.75%
const TCG_COMMISSION_CAP_CENTS = rationalFromCents(7500n); // $75.00
const TCG_PROCESSING_RATE = makeRational(250n, 10_000n); // 2.5%
const FIXED_ORDER_FEE_CENTS = rationalFromCents(30n); // $0.30
const MANAPOOL_KEEP_RATE = makeRational(921n, 1000n); // 1 - 0.079 = 0.921
const P2P_CLAIM_DISCOUNT_RATE = makeRational(85n, 100n); // 85%
const P2P_PAYPAL_KEEP_RATE = makeRational(965n, 1000n); // 1 - 0.035 = 0.965
const HALF_LABOR_FACTOR = makeRational(1n, 2n); // 0.5x labor

export function resolveRoutingProfile(
  profile?: Partial<RoutingProfileConfig>,
): RoutingProfileConfig {
  return {
    ...DEFAULT_ROUTING_PROFILE,
    ...profile,
  };
}

export function assessBuylistQuarantine(params: {
  condition: CardCondition;
  language?: string | null;
  isAltered?: boolean | null;
  isMisprint?: boolean | null;
}): QuarantineAssessment {
  const reasons: QuarantineReason[] = [];
  if (params.condition === "DMG") {
    reasons.push("damaged_condition");
  }
  const normalizedLang = (params.language ?? "en").trim().toLowerCase();
  if (normalizedLang !== "en") {
    reasons.push("non_english_language");
  }
  if (params.isAltered === true) {
    reasons.push("altered_card");
  }
  if (params.isMisprint === true) {
    reasons.push("misprint_card");
  }
  return {
    isQuarantined: reasons.length > 0,
    reasons,
  };
}

export function isBuylistQuarantined(params: {
  condition: CardCondition;
  language?: string | null;
  isAltered?: boolean | null;
  isMisprint?: boolean | null;
}): boolean {
  return assessBuylistQuarantine(params).isQuarantined;
}

export function isFreshSkuPriceCache(
  cache: SkuCacheFields | null | undefined,
  expected: {
    scryfallId: string;
    finish: CardFinish;
    condition: CardCondition;
  },
  now: Date = new Date(),
): cache is SkuCacheFields {
  if (!cache) {
    return false;
  }
  if (
    cache.scryfallId.toLowerCase() !== expected.scryfallId.toLowerCase() ||
    cache.finish !== expected.finish ||
    cache.condition !== expected.condition
  ) {
    return false;
  }
  return cache.expiresAt.getTime() > now.getTime();
}

export function applyRetailConditionMultiplier(
  nmPriceCents: bigint,
  condition: CardCondition,
): bigint {
  if (nmPriceCents <= 0n) {
    return 0n;
  }
  const multPct = RETAIL_CONDITION_MULTIPLIER_PCT[condition];
  return mulCentsByRatioHalfUp(nmPriceCents, multPct, 100n);
}

export function applyBuylistConditionMultiplier(
  nmBuylistCents: bigint,
  condition: CardCondition,
  finish: CardFinish,
): bigint {
  if (nmBuylistCents <= 0n || condition === "DMG") {
    return 0n;
  }
  const condPct = BUYLIST_CONDITION_MULTIPLIER_PCT[condition];
  if (condition !== "NM" && (finish === "foil" || finish === "etched")) {
    return mulCentsByRatioHalfUp(
      nmBuylistCents,
      condPct * NON_NM_FOIL_BUYLIST_WEAR_NUM,
      100n * NON_NM_FOIL_BUYLIST_WEAR_DEN,
    );
  }
  return mulCentsByRatioHalfUp(nmBuylistCents, condPct, 100n);
}

/**
 * Resolves the finish-specific Near Mint retail baseline from `card_catalog`
 * (`SPEC.md` §4.B.1) before condition discounting.
 */
export function resolveNmRetailBaselineCents(
  card: CatalogPriceFields,
  finish: CardFinish,
): bigint {
  let resolved: bigint | null = null;
  if (finish === "normal") {
    resolved = coalescePositiveUsdToCents(
      card.tcgMarketNm,
      card.tcgLowNm,
      card.manapoolLowNm,
    );
  } else if (finish === "foil") {
    resolved = coalescePositiveUsdToCents(
      card.tcgMarketFoil,
      card.tcgLowFoil,
      card.manapoolLowFoil,
    );
  } else {
    resolved = coalescePositiveUsdToCents(
      card.tcgMarketEtched,
      card.tcgLowEtched,
      card.manapoolLowEtched,
      card.tcgMarketFoil,
      card.tcgLowFoil,
    );
  }
  return resolved !== null && resolved > 0n ? resolved : 0n;
}

/**
 * Determines Pro-tier paid SKU API eligibility (`TCGAPIs` / `JustTCG`, `SPEC.md` §2.3):
 * - Skips when a fresh 24h `sku_price_cache` entry already exists.
 * - Skips buylist-quarantined items (`DMG`, non-`'en'`, `is_altered`, `is_misprint`).
 * - Skips when `monthly_sku_api_used >= monthly_sku_api_quota` (accounting for
 *   automatic monthly rollover when `sku_api_quota_reset_at <= now`, or Starter quota `0`).
 * - Eligible when finish-specific NM baseline `>= $8.00` (including `NM`, unless
 *   `options.includeHighValueNm === false`) OR when `condition` is `LP`/`MP`/`HP`
 *   with finish-specific NM baseline `>= $1.00` (skipping sub-dollar bulk).
 */
export function evaluatePaidSkuApiEligibility(
  input: RoutingCardInput,
  profileInput?: Partial<RoutingProfileConfig>,
  options: {
    now?: Date;
    includeHighValueNm?: boolean;
    minNonNmBaselineCents?: bigint;
  } = {},
): PaidSkuApiEligibility {
  const profile = resolveRoutingProfile(profileInput);
  const finish = input.finish ?? "normal";
  const condition = input.condition ?? "NM";
  const now = options.now ?? new Date();

  const nmBaselineCents = resolveNmRetailBaselineCents(input.card, finish);
  const nmBaselineUsd = formatCentsToUsd(nmBaselineCents);

  if (
    isFreshSkuPriceCache(
      input.skuPriceCache,
      { scryfallId: input.card.scryfallId, finish, condition },
      now,
    )
  ) {
    return {
      eligible: false,
      nmBaselineCents,
      nmBaselineUsd,
      skipReason: "fresh_cache_hit",
    };
  }

  const quarantine = assessBuylistQuarantine({
    condition,
    language: input.language,
    isAltered: input.isAltered,
    isMisprint: input.isMisprint,
  });
  if (quarantine.isQuarantined) {
    return {
      eligible: false,
      nmBaselineCents,
      nmBaselineUsd,
      skipReason: "quarantined_item",
    };
  }

  const quotaResetElapsed =
    profile.skuApiQuotaResetAt !== undefined &&
    profile.skuApiQuotaResetAt.getTime() <= now.getTime();
  const effectiveQuotaUsed = quotaResetElapsed ? 0 : profile.monthlySkuApiUsed;

  if (
    profile.monthlySkuApiQuota <= 0 ||
    effectiveQuotaUsed >= profile.monthlySkuApiQuota
  ) {
    return {
      eligible: false,
      nmBaselineCents,
      nmBaselineUsd,
      skipReason: "quota_exhausted",
    };
  }

  if (condition === "NM") {
    if (options.includeHighValueNm === false) {
      return {
        eligible: false,
        nmBaselineCents,
        nmBaselineUsd,
        skipReason: "near_mint_condition",
      };
    }
    if (nmBaselineCents < PAID_SKU_API_NM_THRESHOLD_CENTS) {
      return {
        eligible: false,
        nmBaselineCents,
        nmBaselineUsd,
        skipReason: "below_nm_price_threshold",
      };
    }
    return {
      eligible: true,
      nmBaselineCents,
      nmBaselineUsd,
    };
  }

  const minNonNmBaselineCents =
    options.minNonNmBaselineCents ?? PAID_SKU_API_NON_NM_MIN_NM_CENTS;
  if (nmBaselineCents < minNonNmBaselineCents) {
    return {
      eligible: false,
      nmBaselineCents,
      nmBaselineUsd,
      skipReason: "below_nm_price_threshold",
    };
  }

  return {
    eligible: true,
    nmBaselineCents,
    nmBaselineUsd,
  };
}

function resolveCatalogNmTcgBaseline(
  card: CatalogPriceFields,
  finish: CardFinish,
): bigint {
  const cents =
    finish === "normal"
      ? coalescePositiveUsdToCents(card.tcgMarketNm, card.tcgLowNm)
      : finish === "foil"
        ? coalescePositiveUsdToCents(card.tcgMarketFoil, card.tcgLowFoil)
        : coalescePositiveUsdToCents(
            card.tcgMarketEtched,
            card.tcgLowEtched,
            card.tcgMarketFoil,
          );
  return cents !== null && cents > 0n ? cents : 0n;
}

function resolveCatalogNmMpBaseline(
  card: CatalogPriceFields,
  finish: CardFinish,
): bigint {
  const cents =
    finish === "normal"
      ? coalescePositiveUsdToCents(
          card.manapoolLowNm,
          card.tcgLowNm,
          card.tcgMarketNm,
        )
      : finish === "foil"
        ? coalescePositiveUsdToCents(
            card.manapoolLowFoil,
            card.tcgLowFoil,
            card.tcgMarketFoil,
          )
        : coalescePositiveUsdToCents(
            card.manapoolLowEtched,
            card.tcgLowEtched,
            card.tcgMarketEtched,
            card.tcgLowFoil,
            card.tcgMarketFoil,
          );
  return cents !== null && cents > 0n ? cents : 0n;
}

function resolveCatalogNmP2pBaseline(
  card: CatalogPriceFields,
  finish: CardFinish,
): bigint {
  const cents =
    finish === "normal"
      ? coalescePositiveUsdToCents(card.tcgLowNm, card.tcgMarketNm)
      : finish === "foil"
        ? coalescePositiveUsdToCents(card.tcgLowFoil, card.tcgMarketFoil)
        : coalescePositiveUsdToCents(
            card.tcgLowEtched,
            card.tcgMarketEtched,
            card.tcgLowFoil,
            card.tcgMarketFoil,
          );
  return cents !== null && cents > 0n ? cents : 0n;
}

function resolveCatalogNmCkBuylistCash(
  card: CatalogPriceFields,
  finish: CardFinish,
): bigint {
  // SPEC.md §4.B.1: etched never assumes foil buylist when etched buylist is null.
  const cents =
    finish === "normal"
      ? parseUsdToCents(card.ckBuylistCashNm)
      : finish === "foil"
        ? parseUsdToCents(card.ckBuylistCashFoil)
        : parseUsdToCents(card.ckBuylistCashEtched);
  return cents !== null && cents > 0n ? cents : 0n;
}

function resolveCatalogNmCkBuylistCredit(
  card: CatalogPriceFields,
  finish: CardFinish,
): bigint | null {
  const cents =
    finish === "normal"
      ? parseUsdToCents(card.ckBuylistCreditNm)
      : finish === "foil"
        ? parseUsdToCents(card.ckBuylistCreditFoil)
        : parseUsdToCents(card.ckBuylistCreditEtched);
  return cents !== null && cents >= 0n ? cents : null;
}

/**
 * Resolves finish- and condition-adjusted baselines across TCGplayer, Mana Pool,
 * P2P (85% TCG Low), Card Kingdom cash/credit, and Card Conduit (`SPEC.md` §4.B.1).
 */
export function resolveChannelBaselines(
  input: RoutingCardInput,
  options: RoutingEngineOptions = {},
): ResolvedChannelBaselines {
  const finish = input.finish ?? "normal";
  const condition = input.condition ?? "NM";
  const now = options.now ?? new Date();

  const quarantine = assessBuylistQuarantine({
    condition,
    language: input.language,
    isAltered: input.isAltered,
    isMisprint: input.isMisprint,
  });

  const freshCache = isFreshSkuPriceCache(
    input.skuPriceCache,
    { scryfallId: input.card.scryfallId, finish, condition },
    now,
  )
    ? input.skuPriceCache
    : null;

  const catalogTcgCents = applyRetailConditionMultiplier(
    resolveCatalogNmTcgBaseline(input.card, finish),
    condition,
  );
  const catalogMpCents = applyRetailConditionMultiplier(
    resolveCatalogNmMpBaseline(input.card, finish),
    condition,
  );
  const catalogP2pCents = applyRetailConditionMultiplier(
    resolveCatalogNmP2pBaseline(input.card, finish),
    condition,
  );

  const cachedTcgCents = freshCache
    ? coalescePositiveUsdToCents(
        freshCache.retailMarketUsd,
        freshCache.retailLowUsd,
      )
    : null;
  const cachedLowFirstCents = freshCache
    ? coalescePositiveUsdToCents(
        freshCache.retailLowUsd,
        freshCache.retailMarketUsd,
      )
    : null;

  const pRetailTcgCents =
    cachedTcgCents !== null && cachedTcgCents >= 0n
      ? cachedTcgCents
      : catalogTcgCents;

  // On a fresh SKU cache hit, condition-specific retail low overrides NM fallback;
  // if cached retail columns are NULL, fall back to condition-adjusted card_catalog.
  const pRetailMpCents =
    cachedLowFirstCents !== null && cachedLowFirstCents >= 0n
      ? cachedLowFirstCents
      : catalogMpCents;

  const pRetailP2pCents =
    cachedLowFirstCents !== null && cachedLowFirstCents >= 0n
      ? cachedLowFirstCents
      : catalogP2pCents;

  const pSaleP2pClaimCents = mulCentsByRatioHalfUp(pRetailP2pCents, 85n, 100n);

  const initialFmvCents =
    pRetailTcgCents > 0n
      ? pRetailTcgCents
      : maxCents(pRetailMpCents, pRetailP2pCents);

  let pBuyCkCents = 0n;
  let pBuyConduitCents = 0n;
  let ckStoreCreditRawCents = 0n;

  if (!quarantine.isQuarantined) {
    const nmCkCashCents = resolveCatalogNmCkBuylistCash(input.card, finish);
    const catalogCkCashCents = applyBuylistConditionMultiplier(
      nmCkCashCents,
      condition,
      finish,
    );

    const cachedBuylistCashCents = freshCache
      ? parseUsdToCents(freshCache.buylistCashUsd)
      : null;

    // SPEC.md §4.B.1: fall back per-channel to condition-adjusted card_catalog
    // when sku_price_cache.buylist_cash_usd is NULL.
    pBuyCkCents =
      cachedBuylistCashCents !== null && cachedBuylistCashCents >= 0n
        ? cachedBuylistCashCents
        : catalogCkCashCents;

    const explicitConduitQuote = parseUsdToCents(input.conduitBuylistCashUsd);
    pBuyConduitCents =
      explicitConduitQuote !== null && explicitConduitQuote >= 0n
        ? explicitConduitQuote
        : pBuyCkCents;

    const cachedBuylistCreditCents = freshCache
      ? parseUsdToCents(freshCache.buylistCreditUsd)
      : null;

    if (cachedBuylistCreditCents !== null && cachedBuylistCreditCents >= 0n) {
      ckStoreCreditRawCents = cachedBuylistCreditCents;
    } else if (cachedBuylistCashCents !== null && cachedBuylistCashCents >= 0n) {
      ckStoreCreditRawCents = mulCentsByRatioHalfUp(pBuyCkCents, 130n, 100n);
    } else {
      const nmExplicitCredit = resolveCatalogNmCkBuylistCredit(
        input.card,
        finish,
      );
      const expectedDefaultNmCredit = mulCentsByRatioHalfUp(
        nmCkCashCents,
        130n,
        100n,
      );
      if (
        nmExplicitCredit !== null &&
        nmExplicitCredit !== expectedDefaultNmCredit
      ) {
        ckStoreCreditRawCents = applyBuylistConditionMultiplier(
          nmExplicitCredit,
          condition,
          finish,
        );
      } else {
        ckStoreCreditRawCents = mulCentsByRatioHalfUp(pBuyCkCents, 130n, 100n);
      }
    }
  }

  return {
    usedFreshSkuCache: freshCache !== null,
    isQuarantined: quarantine.isQuarantined,
    quarantineReasons: quarantine.reasons,
    initialFmvCents,
    initialFmvUsd: formatCentsToUsd(initialFmvCents),
    pRetailTcgCents,
    pRetailTcgUsd: formatCentsToUsd(pRetailTcgCents),
    pRetailMpCents,
    pRetailMpUsd: formatCentsToUsd(pRetailMpCents),
    pRetailP2pCents,
    pRetailP2pUsd: formatCentsToUsd(pRetailP2pCents),
    pSaleP2pClaimCents,
    pSaleP2pClaimUsd: formatCentsToUsd(pSaleP2pClaimCents),
    pBuyCkCents,
    pBuyCkUsd: formatCentsToUsd(pBuyCkCents),
    pBuyConduitCents,
    pBuyConduitUsd: formatCentsToUsd(pBuyConduitCents),
    ckStoreCreditRawCents,
    ckStoreCreditRawUsd: formatCentsToUsd(ckStoreCreditRawCents),
  };
}

function selectShippingCostCents(
  salePriceRationalCents: RationalCents,
  trackedThresholdCents: bigint,
  pweShippingCents: bigint,
  trackedShippingCents: bigint,
): bigint {
  // P_sale < tracked_threshold_usd -> PWE, else tracked
  return salePriceRationalCents.num <
    trackedThresholdCents * salePriceRationalCents.den
    ? pweShippingCents
    : trackedShippingCents;
}

function computeCreditArbNetCents(
  baselines: ResolvedChannelBaselines,
  input: RoutingCardInput,
): bigint {
  if (baselines.isQuarantined) {
    return 0n;
  }

  // If an explicit non-default store-credit quote came from sku_price_cache or
  // card_catalog, evaluate `Credit_CK * 0.82`; otherwise evaluate exact
  // `(P_buy_CK * 1.30) * 0.82 = P_buy_CK * 1.066` without intermediate cent drift.
  const finish = input.finish ?? "normal";
  const nmCkCash = resolveCatalogNmCkBuylistCash(input.card, finish);
  const nmCkCredit = resolveCatalogNmCkBuylistCredit(input.card, finish);
  const expectedDefaultNmCredit = mulCentsByRatioHalfUp(nmCkCash, 130n, 100n);
  const hasExplicitCacheCredit =
    baselines.usedFreshSkuCache &&
    parseUsdToCents(input.skuPriceCache?.buylistCreditUsd) !== null;
  const hasExplicitCacheCash =
    baselines.usedFreshSkuCache &&
    parseUsdToCents(input.skuPriceCache?.buylistCashUsd) !== null;
  const hasExplicitCustomCatalogCredit =
    !hasExplicitCacheCash &&
    nmCkCredit !== null &&
    nmCkCredit !== expectedDefaultNmCredit;

  if (hasExplicitCacheCredit || hasExplicitCustomCatalogCredit) {
    return mulCentsByRatioHalfUp(baselines.ckStoreCreditRawCents, 82n, 100n);
  }
  return mulCentsByRatioHalfUp(baselines.pBuyCkCents, 1066n, 1000n);
}

function conduitTierToChannel(
  tier: ConduitTierPreference,
): "conduit_sorted" | "conduit_curated" | "conduit_standard" {
  if (tier === "sorted") return "conduit_sorted";
  if (tier === "standard") return "conduit_standard";
  return "conduit_curated";
}

/**
 * Evaluates all single, P2P, wholesale buylist cash, Conduit tier, and CK credit
 * arbitrage net payouts in exact rational cents (`SPEC.md` §4.B.2).
 */
export function computeChannelNets(
  baselines: ResolvedChannelBaselines,
  input: RoutingCardInput,
  profileInput?: Partial<RoutingProfileConfig>,
  options: RoutingEngineOptions = {},
): ComputedChannelNets {
  const profile = resolveRoutingProfile(profileInput);

  const hourlyRateCents = parseRequiredUsdToCents(
    profile.hourlyLaborRateUsd,
    "hourlyLaborRateUsd",
  );
  const pweShippingCents = parseRequiredUsdToCents(
    profile.pweShippingCostUsd,
    "pweShippingCostUsd",
  );
  const trackedShippingCents = parseRequiredUsdToCents(
    profile.trackedShippingCostUsd,
    "trackedShippingCostUsd",
  );
  const trackedThresholdCents = parseRequiredUsdToCents(
    profile.trackedThresholdUsd,
    "trackedThresholdUsd",
  );

  if (hourlyRateCents < 0n) {
    throw new RangeError("hourlyLaborRateUsd cannot be negative.");
  }
  if (pweShippingCents < 0n) {
    throw new RangeError("pweShippingCostUsd cannot be negative.");
  }
  if (trackedShippingCents < 0n) {
    throw new RangeError("trackedShippingCostUsd cannot be negative.");
  }
  if (trackedThresholdCents < 0n) {
    throw new RangeError("trackedThresholdUsd cannot be negative.");
  }
  if (profile.secondsPerSingleOrder < 0) {
    throw new RangeError("secondsPerSingleOrder cannot be negative.");
  }

  // Exact rational C_labor = (seconds_per_single_order / 3600) * hourly_labor_rate_usd
  const cLabor = makeRational(
    BigInt(profile.secondsPerSingleOrder) * hourlyRateCents,
    3600n,
  );
  const halfCLabor = mulRational(HALF_LABOR_FACTOR, cLabor);

  // 1. TCGplayer Single:
  // Net_TCG = P_retail_TCG - min(P_retail_TCG * 0.1075, 75.00) - (P_retail_TCG * 0.025) - 0.30 - C_ship(P_retail_TCG) - C_labor
  const pTcg = rationalFromCents(baselines.pRetailTcgCents);
  const shipTcgCents = selectShippingCostCents(
    pTcg,
    trackedThresholdCents,
    pweShippingCents,
    trackedShippingCents,
  );
  const tcgCommission = minRational(
    mulRational(pTcg, TCG_COMMISSION_RATE),
    TCG_COMMISSION_CAP_CENTS,
  );
  const tcgProcessing = mulRational(pTcg, TCG_PROCESSING_RATE);
  const netTcgRational = subRational(
    subRational(
      subRational(subRational(pTcg, tcgCommission), tcgProcessing),
      addRational(FIXED_ORDER_FEE_CENTS, rationalFromCents(shipTcgCents)),
    ),
    cLabor,
  );
  const netTcgplayerSingleCents = roundRationalToCents(netTcgRational);

  // 2. Mana Pool Single:
  // Net_MP = (P_retail_MP * 0.921) - 0.30 - C_ship(P_retail_MP) - C_labor
  const pMp = rationalFromCents(baselines.pRetailMpCents);
  const shipMpCents = selectShippingCostCents(
    pMp,
    trackedThresholdCents,
    pweShippingCents,
    trackedShippingCents,
  );
  const netMpRational = subRational(
    subRational(
      mulRational(pMp, MANAPOOL_KEEP_RATE),
      addRational(FIXED_ORDER_FEE_CENTS, rationalFromCents(shipMpCents)),
    ),
    cLabor,
  );
  const netManapoolSingleCents = roundRationalToCents(netMpRational);

  // 3. Discord / Facebook P2P 85% Claim Sale:
  // Net_P2P = ((P_retail_P2P * 0.85) * 0.965) - C_ship(P_retail_P2P * 0.85) - (0.5 * C_labor)
  const pP2p = rationalFromCents(baselines.pRetailP2pCents);
  const pSaleP2p = mulRational(pP2p, P2P_CLAIM_DISCOUNT_RATE);
  const shipP2pCents = selectShippingCostCents(
    pSaleP2p,
    trackedThresholdCents,
    pweShippingCents,
    trackedShippingCents,
  );
  const netP2pRational = subRational(
    subRational(
      mulRational(pSaleP2p, P2P_PAYPAL_KEEP_RATE),
      rationalFromCents(shipP2pCents),
    ),
    halfCLabor,
  );
  const netP2p85PctCents = roundRationalToCents(netP2pRational);

  // Best single channel selection (deterministic tie-break: TCG -> MP -> P2P)
  let bestSingleChannel:
    | "tcgplayer_single"
    | "manapool_single"
    | "p2p_85_pct" = "tcgplayer_single";
  let netBestSingleCents = netTcgplayerSingleCents;
  if (netManapoolSingleCents > netBestSingleCents) {
    netBestSingleCents = netManapoolSingleCents;
    bestSingleChannel = "manapool_single";
  }
  if (netP2p85PctCents > netBestSingleCents) {
    netBestSingleCents = netP2p85PctCents;
    bestSingleChannel = "p2p_85_pct";
  }

  // 4. Wholesale Buylist Cash Channels
  let netCkCashCents = 0n;
  let netConduitSortedCents = 0n;
  let netConduitCuratedCents = 0n;
  let netConduitStandardCents = 0n;

  if (!baselines.isQuarantined) {
    netCkCashCents = baselines.pBuyCkCents;
    netConduitSortedCents = mulCentsByRatioHalfUp(
      baselines.pBuyConduitCents,
      98n,
      100n,
    );
    netConduitCuratedCents = mulCentsByRatioHalfUp(
      baselines.pBuyConduitCents,
      95n,
      100n,
    );
    const conduitStandardRaw = roundRationalToCents(
      subRational(
        mulRational(
          rationalFromCents(baselines.pBuyConduitCents),
          makeRational(90n, 100n),
        ),
        rationalFromCents(3n),
      ),
    );
    netConduitStandardCents = conduitStandardRaw > 0n ? conduitStandardRaw : 0n;
  }

  const activeConduitChannel = conduitTierToChannel(
    profile.conduitTierPreference,
  );
  const netConduitActiveTierCents =
    activeConduitChannel === "conduit_sorted"
      ? netConduitSortedCents
      : activeConduitChannel === "conduit_standard"
        ? netConduitStandardCents
        : netConduitCuratedCents;

  const buylistCashMode = options.buylistCashMode ?? "best";
  let activeBuylistCashChannel:
    | "ck_cash"
    | "conduit_sorted"
    | "conduit_curated"
    | "conduit_standard";
  let netBuylistCashCents: bigint;

  if (baselines.isQuarantined) {
    activeBuylistCashChannel =
      buylistCashMode === "conduit" ? activeConduitChannel : "ck_cash";
    netBuylistCashCents = 0n;
  } else if (buylistCashMode === "ck_direct") {
    activeBuylistCashChannel = "ck_cash";
    netBuylistCashCents = netCkCashCents;
  } else if (buylistCashMode === "conduit") {
    activeBuylistCashChannel = activeConduitChannel;
    netBuylistCashCents = netConduitActiveTierCents;
  } else if (netConduitActiveTierCents > netCkCashCents) {
    activeBuylistCashChannel = activeConduitChannel;
    netBuylistCashCents = netConduitActiveTierCents;
  } else {
    activeBuylistCashChannel = "ck_cash";
    netBuylistCashCents = netCkCashCents;
  }

  // 5. Store-Credit Arbitrage (`Net_Credit_Arb = (P_buy_CK * 1.30) * 0.82`)
  const netCkCreditCents = computeCreditArbNetCents(baselines, input);

  return {
    laborCostUsd: formatCentsToUsd(roundRationalToCents(cLabor)),
    shipTcgUsd: formatCentsToUsd(shipTcgCents),
    shipMpUsd: formatCentsToUsd(shipMpCents),
    shipP2pUsd: formatCentsToUsd(shipP2pCents),
    netTcgplayerSingleCents,
    netTcgplayerSingleUsd: formatCentsToUsd(netTcgplayerSingleCents),
    netManapoolSingleCents,
    netManapoolSingleUsd: formatCentsToUsd(netManapoolSingleCents),
    netP2p85PctCents,
    netP2p85PctUsd: formatCentsToUsd(netP2p85PctCents),
    netBestSingleCents,
    netBestSingleUsd: formatCentsToUsd(netBestSingleCents),
    bestSingleChannel,
    netCkCashCents,
    netCkCashUsd: formatCentsToUsd(netCkCashCents),
    netConduitSortedCents,
    netConduitSortedUsd: formatCentsToUsd(netConduitSortedCents),
    netConduitCuratedCents,
    netConduitCuratedUsd: formatCentsToUsd(netConduitCuratedCents),
    netConduitStandardCents,
    netConduitStandardUsd: formatCentsToUsd(netConduitStandardCents),
    activeConduitChannel,
    netConduitActiveTierCents,
    netConduitActiveTierUsd: formatCentsToUsd(netConduitActiveTierCents),
    activeBuylistCashChannel,
    netBuylistCashCents,
    netBuylistCashUsd: formatCentsToUsd(netBuylistCashCents),
    netCkCreditCents,
    netCkCreditUsd: formatCentsToUsd(netCkCreditCents),
  };
}

function selectBulkSubchannel(
  baselines: ResolvedChannelBaselines,
): "binder_local" | "bulk_wholesale" {
  const retailRef =
    baselines.pRetailTcgCents > 0n
      ? baselines.pRetailTcgCents
      : maxCents(baselines.pRetailMpCents, baselines.pRetailP2pCents);
  return retailRef >= BINDER_LOCAL_RETAIL_MIN_CENTS
    ? "binder_local"
    : "bulk_wholesale";
}

interface BuylistChannelFilter {
  readonly allowCkCash: boolean;
  readonly allowCkCredit: boolean;
  readonly allowConduit: boolean;
}

interface BucketDecisionChoice {
  readonly assignedBucket: AssignedBucket;
  readonly recommendedChannel: RecommendedChannel;
  readonly optimalUnitNetCents: bigint;
}

function decideBucketForEvaluatedCard(
  baselines: ResolvedChannelBaselines,
  nets: ComputedChannelNets,
  minSingleGainOverBuylistCents: bigint,
  nonBuylistFallbackBucket: "PILE_2_SINGLES" | "PILE_4_BULK",
  nonBuylistFallbackChannel: RecommendedChannel,
  nonBuylistFallbackUnitNetCents: bigint,
  filter: BuylistChannelFilter,
): BucketDecisionChoice {
  const bulkChannel = selectBulkSubchannel(baselines);

  let effectivePBuyCashCents = 0n;
  let effectiveNetBuylistCashCents = 0n;
  let effectiveBuylistCashChannel:
    | "ck_cash"
    | "conduit_sorted"
    | "conduit_curated"
    | "conduit_standard" = "ck_cash";

  if (!baselines.isQuarantined) {
    if (filter.allowCkCash && filter.allowConduit) {
      effectivePBuyCashCents = maxCents(
        baselines.pBuyCkCents,
        baselines.pBuyConduitCents,
      );
      if (nets.netConduitActiveTierCents > nets.netCkCashCents) {
        effectiveBuylistCashChannel = nets.activeConduitChannel;
        effectiveNetBuylistCashCents = nets.netConduitActiveTierCents;
      } else {
        effectiveBuylistCashChannel = "ck_cash";
        effectiveNetBuylistCashCents = nets.netCkCashCents;
      }
    } else if (filter.allowCkCash) {
      effectivePBuyCashCents = baselines.pBuyCkCents;
      effectiveBuylistCashChannel = "ck_cash";
      effectiveNetBuylistCashCents = nets.netCkCashCents;
    } else if (filter.allowConduit) {
      effectivePBuyCashCents = baselines.pBuyConduitCents;
      effectiveBuylistCashChannel = nets.activeConduitChannel;
      effectiveNetBuylistCashCents = nets.netConduitActiveTierCents;
    }
  }

  const maxAvailableBuylistRawCents = maxCents(
    effectivePBuyCashCents,
    filter.allowCkCredit && !baselines.isQuarantined
      ? baselines.pBuyCkCents
      : 0n,
  );

  // Step 1: PILE_4_BULK — `(quarantined || P_buy < $0.50) && Net_BestSingle < $0.75`
  if (
    (baselines.isQuarantined ||
      maxAvailableBuylistRawCents < BUYLIST_MIN_ELIGIBLE_CENTS) &&
    nets.netBestSingleCents < BULK_SINGLE_NET_FLOOR_CENTS
  ) {
    return {
      assignedBucket: "PILE_4_BULK",
      recommendedChannel: bulkChannel,
      optimalUnitNetCents: 0n,
    };
  }

  // Step 2: PILE_3_CREDIT_ARB — buylist-eligible (`P_buy_CK >= $0.50`), credit arb enabled,
  // `Net_Credit_Arb > Net_Buylist_Cash`, AND `(Net_BestSingle - Net_Credit_Arb) < tau`
  if (
    !baselines.isQuarantined &&
    filter.allowCkCredit &&
    baselines.pBuyCkCents >= BUYLIST_MIN_ELIGIBLE_CENTS &&
    nets.netCkCreditCents > effectiveNetBuylistCashCents &&
    nets.netBestSingleCents - nets.netCkCreditCents <
      minSingleGainOverBuylistCents
  ) {
    return {
      assignedBucket: "PILE_3_CREDIT_ARB",
      recommendedChannel: "ck_credit",
      optimalUnitNetCents: nets.netCkCreditCents,
    };
  }

  // Step 3: PILE_1_BUYLIST — buylist-eligible (`P_buy >= $0.50`) AND
  // `(Net_BestSingle - Net_Buylist_Cash) < tau`
  if (
    !baselines.isQuarantined &&
    (filter.allowCkCash || filter.allowConduit) &&
    effectivePBuyCashCents >= BUYLIST_MIN_ELIGIBLE_CENTS &&
    nets.netBestSingleCents - effectiveNetBuylistCashCents <
      minSingleGainOverBuylistCents
  ) {
    return {
      assignedBucket: "PILE_1_BUYLIST",
      recommendedChannel: effectiveBuylistCashChannel,
      optimalUnitNetCents: effectiveNetBuylistCashCents,
    };
  }

  // Step 4: PILE_2_SINGLES (with `< $0.75` floor safety fallback to `PILE_4_BULK`)
  return {
    assignedBucket: nonBuylistFallbackBucket,
    recommendedChannel: nonBuylistFallbackChannel,
    optimalUnitNetCents: nonBuylistFallbackUnitNetCents,
  };
}

/**
 * Evaluates a single card line item through the strict 4-bucket decision tree
 * (`SPEC.md` §4.C):
 *   1. `PILE_4_BULK`
 *   2. `PILE_3_CREDIT_ARB`
 *   3. `PILE_1_BUYLIST`
 *   4. `PILE_2_SINGLES` (with `< $0.75` guard falling back to `PILE_4_BULK`)
 */
export function evaluateCardRouting(
  input: RoutingCardInput,
  profileInput?: Partial<RoutingProfileConfig>,
  options: RoutingEngineOptions = {},
): EvaluatedCardRouting {
  const profile = resolveRoutingProfile(profileInput);
  const finish = input.finish ?? "normal";
  const condition = input.condition ?? "NM";
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(
      `Card quantity must be a positive integer (got ${quantity}).`,
    );
  }
  const language = (input.language ?? "en").trim().toLowerCase() || "en";
  const isAltered = Boolean(input.isAltered);
  const isMisprint = Boolean(input.isMisprint);

  const baselines = resolveChannelBaselines(
    {
      ...input,
      finish,
      condition,
      quantity,
      language,
      isAltered,
      isMisprint,
    },
    options,
  );
  const nets = computeChannelNets(baselines, input, profile, options);

  const minSingleGainOverBuylistCents = parseRequiredUsdToCents(
    profile.minSingleNetGainOverBuylistUsd,
    "minSingleNetGainOverBuylistUsd",
  );

  const buylistCashMode = options.buylistCashMode ?? "best";
  const bulkChannel = selectBulkSubchannel(baselines);
  const nonBuylistFallbackBucket: "PILE_2_SINGLES" | "PILE_4_BULK" =
    nets.netBestSingleCents >= BULK_SINGLE_NET_FLOOR_CENTS
      ? "PILE_2_SINGLES"
      : "PILE_4_BULK";
  const nonBuylistFallbackChannel: RecommendedChannel =
    nonBuylistFallbackBucket === "PILE_2_SINGLES"
      ? nets.bestSingleChannel
      : bulkChannel;
  const nonBuylistFallbackUnitNetCents =
    nonBuylistFallbackBucket === "PILE_2_SINGLES"
      ? nets.netBestSingleCents
      : 0n;

  const choice = decideBucketForEvaluatedCard(
    baselines,
    nets,
    minSingleGainOverBuylistCents,
    nonBuylistFallbackBucket,
    nonBuylistFallbackChannel,
    nonBuylistFallbackUnitNetCents,
    {
      allowCkCash: buylistCashMode !== "conduit",
      allowCkCredit: profile.enableCreditArbitrage,
      allowConduit: buylistCashMode !== "ck_direct",
    },
  );

  return {
    scryfallId: input.card.scryfallId,
    finish,
    condition,
    quantity,
    language,
    isAltered,
    isMisprint,
    baselines,
    nets,
    assignedBucket: choice.assignedBucket,
    recommendedChannel: choice.recommendedChannel,
    optimalUnitNetCents: choice.optimalUnitNetCents,
    optimalUnitNetUsd: formatCentsToUsd(choice.optimalUnitNetCents),
    nonBuylistFallbackBucket,
    nonBuylistFallbackChannel,
    nonBuylistFallbackUnitNetCents,
    nonBuylistFallbackUnitNetUsd: formatCentsToUsd(
      nonBuylistFallbackUnitNetCents,
    ),
  };
}

function getBuylistShipmentVendor(
  bucket: AssignedBucket,
  channel: RecommendedChannel,
): BuylistVendor | null {
  if (bucket !== "PILE_1_BUYLIST" && bucket !== "PILE_3_CREDIT_ARB") {
    return null;
  }
  if (channel === "ck_cash" || channel === "ck_credit") {
    return "card_kingdom";
  }
  return "card_conduit";
}

function createEmptyBucketMetrics(bucket: AssignedBucket): BucketSummaryMetrics {
  return {
    bucket,
    lineItemCount: 0,
    totalCards: 0,
    grossFmvUsd: "0.00",
    optimalNetUsd: "0.00",
  };
}

/**
 * Routes an entire acquisition lot (`SPEC.md` §4.C–4.D):
 * 1. Evaluates each card line item deterministically.
 * 2. Applies the lot-level outbound buylist box shipping guardrail (`$12.00`
 *    default per distinct wholesale vendor shipment; combines CK Cash + CK
 *    Credit into one box, charges separate boxes when shipping to both Card
 *    Conduit and Card Kingdom, and automatically demotes any vendor buylist
 *    box whose margin over non-buylist fallbacks cannot cover box postage).
 * 3. Allocates `purchaseCostUsd` proportionally to initial condition-adjusted
 *    FMV for IRS Schedule C COGS reporting.
 */
export function routeCollectionLot(
  lotInput: RouteCollectionLotInput,
): RouteCollectionLotResult {
  const profile = resolveRoutingProfile(lotInput.profile);
  const options = lotInput.options ?? {};

  const purchaseCostCents = parseRequiredUsdToCents(
    lotInput.purchaseCostUsd,
    "purchaseCostUsd",
  );
  if (purchaseCostCents < 0n) {
    throw new RangeError("purchaseCostUsd cannot be negative.");
  }

  const boxShippingPerVendorCents = parseRequiredUsdToCents(
    profile.outboundBuylistBoxShippingUsd,
    "outboundBuylistBoxShippingUsd",
  );
  if (boxShippingPerVendorCents < 0n) {
    throw new RangeError("outboundBuylistBoxShippingUsd cannot be negative.");
  }

  const evaluatedItems = lotInput.items.map((item) =>
    evaluateCardRouting(item, profile, options),
  );

  const minSingleGainOverBuylistCents = parseRequiredUsdToCents(
    profile.minSingleNetGainOverBuylistUsd,
    "minSingleNetGainOverBuylistUsd",
  );
  const buylistCashMode = options.buylistCashMode ?? "best";
  const baseAllowCkCash = buylistCashMode !== "conduit";
  const baseAllowCkCredit = profile.enableCreditArbitrage;
  const baseAllowConduit = buylistCashMode !== "ck_direct";

  const costBasisAllocations = allocateScheduleCCostBasis(
    purchaseCostCents,
    evaluatedItems.map((ev) => ({
      quantity: ev.quantity,
      unitFmvCents: ev.baselines.initialFmvCents,
    })),
  );

  // Group initial unconstrained buylist assignments by outbound vendor (`card_kingdom` vs `card_conduit`)
  const initialVendorItemIndices = new Map<BuylistVendor, number[]>();
  for (let idx = 0; idx < evaluatedItems.length; idx += 1) {
    const ev = evaluatedItems[idx]!;
    const vendor = getBuylistShipmentVendor(
      ev.assignedBucket,
      ev.recommendedChannel,
    );
    if (vendor !== null) {
      const existing = initialVendorItemIndices.get(vendor) ?? [];
      existing.push(idx);
      initialVendorItemIndices.set(vendor, existing);
    }
  }

  // Evaluate compatible active vendor subsets ordered from fewest outbound boxes
  // to most boxes (`0 -> 1 -> 2`), cascading items from any unviable vendor box
  // into the surviving buylist vendor (when eligible) or non-buylist fallbacks
  // (`PILE_2_SINGLES` / `PILE_4_BULK`) and picking the strict net-payout winner.
  const candidateVendorSubsets: ReadonlyArray<ReadonlySet<BuylistVendor>> = [
    new Set<BuylistVendor>(),
    new Set<BuylistVendor>(["card_kingdom"]),
    new Set<BuylistVendor>(["card_conduit"]),
    new Set<BuylistVendor>(["card_kingdom", "card_conduit"]),
  ];

  let bestChoices: BucketDecisionChoice[] = [];
  let bestNetAfterPostageCents: bigint | null = null;
  let bestUsedVendorCount = 0;

  for (const allowedVendors of candidateVendorSubsets) {
    const filter: BuylistChannelFilter = {
      allowCkCash: allowedVendors.has("card_kingdom") && baseAllowCkCash,
      allowCkCredit: allowedVendors.has("card_kingdom") && baseAllowCkCredit,
      allowConduit: allowedVendors.has("card_conduit") && baseAllowConduit,
    };

    const choices: BucketDecisionChoice[] = [];
    const usedVendors = new Set<BuylistVendor>();
    let candidateSubtotalCents = 0n;

    for (let idx = 0; idx < evaluatedItems.length; idx += 1) {
      const ev = evaluatedItems[idx]!;
      const choice = decideBucketForEvaluatedCard(
        ev.baselines,
        ev.nets,
        minSingleGainOverBuylistCents,
        ev.nonBuylistFallbackBucket,
        ev.nonBuylistFallbackChannel,
        ev.nonBuylistFallbackUnitNetCents,
        filter,
      );
      choices.push(choice);
      candidateSubtotalCents += BigInt(ev.quantity) * choice.optimalUnitNetCents;
      const vendor = getBuylistShipmentVendor(
        choice.assignedBucket,
        choice.recommendedChannel,
      );
      if (vendor !== null) {
        usedVendors.add(vendor);
      }
    }

    const candidateBoxShippingCents =
      BigInt(usedVendors.size) * boxShippingPerVendorCents;
    const candidateNetAfterPostageCents =
      candidateSubtotalCents - candidateBoxShippingCents;

    if (
      bestNetAfterPostageCents === null ||
      candidateNetAfterPostageCents > bestNetAfterPostageCents ||
      (candidateNetAfterPostageCents === bestNetAfterPostageCents &&
        usedVendors.size < bestUsedVendorCount)
    ) {
      bestNetAfterPostageCents = candidateNetAfterPostageCents;
      bestChoices = choices;
      bestUsedVendorCount = usedVendors.size;
    }
  }

  const finalVendorItemIndices = new Map<BuylistVendor, number[]>();
  for (let idx = 0; idx < evaluatedItems.length; idx += 1) {
    const choice = bestChoices[idx]!;
    const vendor = getBuylistShipmentVendor(
      choice.assignedBucket,
      choice.recommendedChannel,
    );
    if (vendor !== null) {
      const existing = finalVendorItemIndices.get(vendor) ?? [];
      existing.push(idx);
      finalVendorItemIndices.set(vendor, existing);
    }
  }

  const vendorShipments: VendorBuylistShipmentSummary[] = [];
  let outboundBoxCount = 0;
  let outboundBoxShippingCents = 0n;

  for (const vendor of ["card_kingdom", "card_conduit"] as const) {
    const finalIndices = finalVendorItemIndices.get(vendor);
    const initialIndices = initialVendorItemIndices.get(vendor);

    if (finalIndices && finalIndices.length > 0) {
      let totalVendorCards = 0;
      let grossBuylistNetCents = 0n;
      let fallbackNetCents = 0n;

      for (const idx of finalIndices) {
        const ev = evaluatedItems[idx]!;
        const choice = bestChoices[idx]!;
        const qty = BigInt(ev.quantity);
        totalVendorCards += ev.quantity;
        grossBuylistNetCents += qty * choice.optimalUnitNetCents;
        fallbackNetCents += qty * ev.nonBuylistFallbackUnitNetCents;
      }

      outboundBoxCount += 1;
      outboundBoxShippingCents += boxShippingPerVendorCents;
      vendorShipments.push({
        vendor,
        totalCards: totalVendorCards,
        grossBuylistNetCents,
        grossBuylistNetUsd: formatCentsToUsd(grossBuylistNetCents),
        fallbackNetCents,
        fallbackNetUsd: formatCentsToUsd(fallbackNetCents),
        boxShippingCents: boxShippingPerVendorCents,
        boxShippingUsd: formatCentsToUsd(boxShippingPerVendorCents),
        demotedToNonBuylist: false,
      });
    } else if (initialIndices && initialIndices.length > 0) {
      let totalVendorCards = 0;
      let grossBuylistNetCents = 0n;
      let fallbackNetCents = 0n;

      for (const idx of initialIndices) {
        const ev = evaluatedItems[idx]!;
        const qty = BigInt(ev.quantity);
        totalVendorCards += ev.quantity;
        grossBuylistNetCents += qty * ev.optimalUnitNetCents;
        fallbackNetCents += qty * ev.nonBuylistFallbackUnitNetCents;
      }

      vendorShipments.push({
        vendor,
        totalCards: totalVendorCards,
        grossBuylistNetCents,
        grossBuylistNetUsd: formatCentsToUsd(grossBuylistNetCents),
        fallbackNetCents,
        fallbackNetUsd: formatCentsToUsd(fallbackNetCents),
        boxShippingCents: 0n,
        boxShippingUsd: "0.00",
        demotedToNonBuylist: true,
      });
    }
  }

  const bucketAccumulators: Record<
    AssignedBucket,
    {
      lineItemCount: number;
      totalCards: number;
      grossFmvCents: bigint;
      optimalNetCents: bigint;
    }
  > = {
    PILE_1_BUYLIST: {
      lineItemCount: 0,
      totalCards: 0,
      grossFmvCents: 0n,
      optimalNetCents: 0n,
    },
    PILE_2_SINGLES: {
      lineItemCount: 0,
      totalCards: 0,
      grossFmvCents: 0n,
      optimalNetCents: 0n,
    },
    PILE_3_CREDIT_ARB: {
      lineItemCount: 0,
      totalCards: 0,
      grossFmvCents: 0n,
      optimalNetCents: 0n,
    },
    PILE_4_BULK: {
      lineItemCount: 0,
      totalCards: 0,
      grossFmvCents: 0n,
      optimalNetCents: 0n,
    },
  };

  let totalCards = 0;
  let estimatedGrossValueCents = 0n;
  let subtotalItemNetPayoutCents = 0n;
  let allocatedCostBasisSumCents = 0n;

  const routedItems: RoutedLotItem[] = evaluatedItems.map((ev, idx) => {
    const sourceInput = lotInput.items[idx]!;
    const costAlloc = costBasisAllocations[idx]!;
    const finalChoice = bestChoices[idx]!;

    const finalBucket = finalChoice.assignedBucket;
    const finalChannel = finalChoice.recommendedChannel;
    const finalUnitNetCents = finalChoice.optimalUnitNetCents;
    const reassignedByPostageGuard =
      finalBucket !== ev.assignedBucket ||
      finalChannel !== ev.recommendedChannel;

    const qtyBig = BigInt(ev.quantity);
    const totalOptimalNetCents = qtyBig * finalUnitNetCents;
    const rowGrossFmvCents = qtyBig * ev.baselines.initialFmvCents;
    const rowCostBasisUsd = formatCentsToUsd(costAlloc.totalCostBasisCents);
    const unitCostBasisUsd = formatCentsToUsd(costAlloc.unitCostBasisCents);

    totalCards += ev.quantity;
    estimatedGrossValueCents += rowGrossFmvCents;
    subtotalItemNetPayoutCents += totalOptimalNetCents;
    allocatedCostBasisSumCents += costAlloc.totalCostBasisCents;

    const bucketAcc = bucketAccumulators[finalBucket];
    bucketAcc.lineItemCount += 1;
    bucketAcc.totalCards += ev.quantity;
    bucketAcc.grossFmvCents += rowGrossFmvCents;
    bucketAcc.optimalNetCents += totalOptimalNetCents;

    return {
      ...ev,
      card: sourceInput.card,
      assignedBucket: finalBucket,
      recommendedChannel: finalChannel,
      optimalUnitNetCents: finalUnitNetCents,
      optimalUnitNetUsd: formatCentsToUsd(finalUnitNetCents),
      allocatedCostBasisCents: costAlloc.totalCostBasisCents,
      allocatedCostBasisUsd: rowCostBasisUsd,
      unitAllocatedCostBasisCents: costAlloc.unitCostBasisCents,
      unitAllocatedCostBasisUsd: unitCostBasisUsd,
      totalAllocatedCostBasisCents: costAlloc.totalCostBasisCents,
      totalAllocatedCostBasisUsd: rowCostBasisUsd,
      totalOptimalNetCents,
      totalOptimalNetUsd: formatCentsToUsd(totalOptimalNetCents),
      demotedFromBuylistByPostageGuard: reassignedByPostageGuard,
      initialAssignedBucket: ev.assignedBucket,
      initialRecommendedChannel: ev.recommendedChannel,
    };
  });

  const estimatedNetPayoutCents =
    subtotalItemNetPayoutCents - outboundBoxShippingCents;
  const estimatedNetProfitCents = estimatedNetPayoutCents - purchaseCostCents;
  const estimatedNetRoiPct =
    purchaseCostCents > 0n
      ? formatBasisPointsToPercent(
          divRoundHalfUp(estimatedNetProfitCents * 10_000n, purchaseCostCents),
        )
      : null;

  const buckets: Record<AssignedBucket, BucketSummaryMetrics> = {
    PILE_1_BUYLIST: createEmptyBucketMetrics("PILE_1_BUYLIST"),
    PILE_2_SINGLES: createEmptyBucketMetrics("PILE_2_SINGLES"),
    PILE_3_CREDIT_ARB: createEmptyBucketMetrics("PILE_3_CREDIT_ARB"),
    PILE_4_BULK: createEmptyBucketMetrics("PILE_4_BULK"),
  };

  for (const bucketKey of [
    "PILE_1_BUYLIST",
    "PILE_2_SINGLES",
    "PILE_3_CREDIT_ARB",
    "PILE_4_BULK",
  ] as const) {
    const acc = bucketAccumulators[bucketKey];
    buckets[bucketKey] = {
      bucket: bucketKey,
      lineItemCount: acc.lineItemCount,
      totalCards: acc.totalCards,
      grossFmvUsd: formatCentsToUsd(acc.grossFmvCents),
      optimalNetUsd: formatCentsToUsd(acc.optimalNetCents),
    };
  }

  return {
    items: routedItems,
    summary: {
      totalLineItems: routedItems.length,
      totalCards,
      purchaseCostCents,
      purchaseCostUsd: formatCentsToUsd(purchaseCostCents),
      allocatedCostBasisSumCents,
      allocatedCostBasisSumUsd: formatCentsToUsd(allocatedCostBasisSumCents),
      estimatedGrossValueCents,
      estimatedGrossValueUsd: formatCentsToUsd(estimatedGrossValueCents),
      subtotalItemNetPayoutCents,
      subtotalItemNetPayoutUsd: formatCentsToUsd(subtotalItemNetPayoutCents),
      outboundBoxCount,
      outboundBoxShippingCents,
      outboundBoxShippingUsd: formatCentsToUsd(outboundBoxShippingCents),
      estimatedNetPayoutCents,
      estimatedNetPayoutUsd: formatCentsToUsd(estimatedNetPayoutCents),
      estimatedNetProfitCents,
      estimatedNetProfitUsd: formatCentsToUsd(estimatedNetProfitCents),
      estimatedNetRoiPct,
      status: "routed",
      vendorShipments,
      buckets,
    },
    toNewLotItems: (targetLotId: string): NewLotItem[] =>
      routedItems.map((item) => ({
        lotId: targetLotId,
        scryfallId: item.scryfallId,
        quantity: item.quantity,
        finish: item.finish,
        condition: item.condition,
        language: item.language,
        isAltered: item.isAltered,
        isMisprint: item.isMisprint,
        allocatedCostBasisUsd: item.allocatedCostBasisUsd,
        netTcgplayerSingle: item.nets.netTcgplayerSingleUsd,
        netManapoolSingle: item.nets.netManapoolSingleUsd,
        netP2p85Pct: item.nets.netP2p85PctUsd,
        netCkCash: item.nets.netCkCashUsd,
        netCkCredit: item.nets.netCkCreditUsd,
        netConduitCurated: item.nets.netConduitCuratedUsd,
        assignedBucket: item.assignedBucket,
        recommendedChannel: item.recommendedChannel,
        optimalUnitNetUsd: item.optimalUnitNetUsd,
      })),
  };
}

export * from "./money";
export * from "./types";
