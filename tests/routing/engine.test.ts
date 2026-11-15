import { describe, expect, it } from "vitest";
import {
  allocateScheduleCCostBasis,
  applyBuylistConditionMultiplier,
  applyRetailConditionMultiplier,
  computeChannelNets,
  DEFAULT_ROUTING_PROFILE,
  divRoundHalfUp,
  evaluateCardRouting,
  evaluatePaidSkuApiEligibility,
  formatCentsToUsd,
  isBuylistQuarantined,
  parseUsdToCents,
  resolveChannelBaselines,
  routeCollectionLot,
  splitAllocatedCostBasis,
} from "@/lib/routing/engine";
import type { CatalogPriceFields, SkuCacheFields } from "@/lib/routing/types";

function makeCard(
  overrides: Partial<CatalogPriceFields> = {},
): CatalogPriceFields {
  return {
    scryfallId: "7673784e-db4b-43a1-8d55-1bb9fc1e284f",
    name: "Lightning Bolt",
    setCode: "2x2",
    setName: "Double Masters 2022",
    collectorNumber: "117",
    rarity: "uncommon",
    finishes: ["nonfoil", "foil", "etched"],
    tcgplayerId: 697344,
    tcgplayerEtchedId: 697345,
    cardkingdomId: 1001,
    cardkingdomFoilId: 1002,
    tcgMarketNm: "10.00",
    tcgLowNm: null,
    tcgMarketFoil: "20.00",
    tcgLowFoil: null,
    tcgMarketEtched: "30.00",
    tcgLowEtched: null,
    manapoolLowNm: null,
    manapoolLowFoil: null,
    manapoolLowEtched: null,
    ckBuylistCashNm: "6.00",
    ckBuylistCreditNm:
      "ckBuylistCashNm" in overrides && !("ckBuylistCreditNm" in overrides)
        ? null
        : "7.80",
    ckBuylistCashFoil: "12.00",
    ckBuylistCreditFoil:
      "ckBuylistCashFoil" in overrides && !("ckBuylistCreditFoil" in overrides)
        ? null
        : "15.60",
    ckBuylistCashEtched: "18.00",
    ckBuylistCreditEtched:
      "ckBuylistCashEtched" in overrides &&
      !("ckBuylistCreditEtched" in overrides)
        ? null
        : "23.40",
    ...overrides,
  };
}

describe("Zero-Float Integer Cents & Exact Rational Math", () => {
  it("parses and formats USD strings with half-up rounding and zero floating-point drift", () => {
    expect(parseUsdToCents("0.10")).toBe(10n);
    expect(parseUsdToCents("0.20")).toBe(20n);
    expect((parseUsdToCents("0.10") ?? 0n) + (parseUsdToCents("0.20") ?? 0n)).toBe(
      30n,
    );
    expect(formatCentsToUsd(30n)).toBe("0.30");
    expect(parseUsdToCents("$1,234.56")).toBe(123456n);
    expect(parseUsdToCents("1.235")).toBe(124n);
    expect(parseUsdToCents("1.2349")).toBe(123n);
    expect(parseUsdToCents("-0.85")).toBe(-85n);
    expect(parseUsdToCents("-$12.34")).toBe(-1234n);
    expect(parseUsdToCents("+$12.34")).toBe(1234n);
    expect(parseUsdToCents("$-12.34")).toBe(-1234n);
    expect(formatCentsToUsd(-85n)).toBe("-0.85");
    expect(parseUsdToCents(null)).toBeNull();
    expect(parseUsdToCents("   ")).toBeNull();
    expect(() => parseUsdToCents("abc")).toThrow(SyntaxError);
    expect(() => parseUsdToCents("$")).toThrow(SyntaxError);
    expect(() => parseUsdToCents("--5.00")).toThrow(SyntaxError);
  });

  it("applies symmetric half-up rational division on exact midpoints", () => {
    expect(divRoundHalfUp(5n, 10n)).toBe(1n);
    expect(divRoundHalfUp(4n, 10n)).toBe(0n);
    expect(divRoundHalfUp(-5n, 10n)).toBe(-1n);
    expect(divRoundHalfUp(1295n, 2n)).toBe(648n);
  });
});

describe("Condition Multipliers, Foil Wear Penalty, & Buylist Quarantine", () => {
  it("applies exact retail condition multipliers (NM=1.00, LP=0.88, MP=0.72, HP=0.52, DMG=0.35)", () => {
    expect(applyRetailConditionMultiplier(1000n, "NM")).toBe(1000n);
    expect(applyRetailConditionMultiplier(1000n, "LP")).toBe(880n);
    expect(applyRetailConditionMultiplier(1000n, "MP")).toBe(720n);
    expect(applyRetailConditionMultiplier(1000n, "HP")).toBe(520n);
    expect(applyRetailConditionMultiplier(1000n, "DMG")).toBe(350n);
  });

  it("applies wholesale buylist multipliers and extra 0.90x wear penalty on non-NM foil/etched", () => {
    // Normal finish: 1.00, 0.80, 0.65, 0.50, 0.00
    expect(applyBuylistConditionMultiplier(1000n, "NM", "normal")).toBe(1000n);
    expect(applyBuylistConditionMultiplier(1000n, "LP", "normal")).toBe(800n);
    expect(applyBuylistConditionMultiplier(1000n, "MP", "normal")).toBe(650n);
    expect(applyBuylistConditionMultiplier(1000n, "HP", "normal")).toBe(500n);
    expect(applyBuylistConditionMultiplier(1000n, "DMG", "normal")).toBe(0n);

    // Foil & Etched: NM untouched (1.00x), LP=0.72x, MP=0.585x, HP=0.45x, DMG=0.00x
    expect(applyBuylistConditionMultiplier(1000n, "NM", "foil")).toBe(1000n);
    expect(applyBuylistConditionMultiplier(1000n, "LP", "foil")).toBe(720n);
    expect(applyBuylistConditionMultiplier(1000n, "MP", "foil")).toBe(585n);
    expect(applyBuylistConditionMultiplier(1000n, "HP", "etched")).toBe(450n);
    expect(applyBuylistConditionMultiplier(1000n, "DMG", "etched")).toBe(0n);
  });

  it("quarantines DMG, non-English, altered, and misprint items from buylist & credit arb", () => {
    expect(isBuylistQuarantined({ condition: "NM", language: "en" })).toBe(
      false,
    );
    expect(isBuylistQuarantined({ condition: "DMG", language: "en" })).toBe(
      true,
    );
    expect(isBuylistQuarantined({ condition: "NM", language: "ja" })).toBe(
      true,
    );
    expect(
      isBuylistQuarantined({
        condition: "NM",
        language: "en",
        isAltered: true,
      }),
    ).toBe(true);
    expect(
      isBuylistQuarantined({
        condition: "NM",
        language: "en",
        isMisprint: true,
      }),
    ).toBe(true);

    // High-value Japanese staple ($50 NM, $35 CK cash if English) -> quarantined out of buylist into PILE_2_SINGLES
    const highValueForeign = evaluateCardRouting(
      {
        card: makeCard({
          tcgMarketNm: "50.00",
          ckBuylistCashNm: "45.00",
          ckBuylistCreditNm: "58.50",
        }),
        condition: "NM",
        language: "ja",
      },
      { enableCreditArbitrage: true },
    );

    expect(highValueForeign.baselines.isQuarantined).toBe(true);
    expect(highValueForeign.baselines.pBuyCkUsd).toBe("0.00");
    expect(highValueForeign.nets.netCkCashUsd).toBe("0.00");
    expect(highValueForeign.nets.netCkCreditUsd).toBe("0.00");
    expect(highValueForeign.nets.netConduitCuratedUsd).toBe("0.00");
    expect(highValueForeign.assignedBucket).toBe("PILE_2_SINGLES");

    // Low-value Altered card ($2.00 NM) -> quarantined & Net_BestSingle < $0.75 -> PILE_4_BULK
    const cheapAltered = evaluateCardRouting({
      card: makeCard({
        tcgMarketNm: "2.00",
        ckBuylistCashNm: "1.50",
      }),
      isAltered: true,
    });
    expect(cheapAltered.assignedBucket).toBe("PILE_4_BULK");

    // Boundary P2P inclusion in Net_BestSingle ($2.65 foreign card: Net_TCG=$0.10, Net_MP=$0.24, Net_P2P=$0.77 >= $0.75) -> PILE_2_SINGLES (p2p_85_pct)
    const p2pFloorRescue = evaluateCardRouting({
      card: makeCard({
        tcgMarketNm: "2.65",
        manapoolLowNm: "2.65",
        tcgLowNm: "2.65",
        ckBuylistCashNm: "1.80",
      }),
      language: "ja",
    });
    expect(p2pFloorRescue.nets.netTcgplayerSingleUsd).toBe("0.10");
    expect(p2pFloorRescue.nets.netManapoolSingleUsd).toBe("0.24");
    expect(p2pFloorRescue.nets.netP2p85PctUsd).toBe("0.77");
    expect(p2pFloorRescue.assignedBucket).toBe("PILE_2_SINGLES");
    expect(p2pFloorRescue.recommendedChannel).toBe("p2p_85_pct");
  });
});

describe("Channel Baselines, Etched Hierarchy, 24h SKU Cache, & Paid API Eligibility", () => {
  it("resolves etched-to-foil retail fallbacks while keeping etched buylist strictly isolated", () => {
    const card = makeCard({
      tcgMarketEtched: null,
      tcgLowEtched: null,
      manapoolLowEtched: null,
      ckBuylistCashEtched: null,
      ckBuylistCreditEtched: null,
      tcgMarketFoil: "24.00",
      tcgLowFoil: "21.00",
      ckBuylistCashFoil: "14.00",
    });

    const baselines = resolveChannelBaselines({
      card,
      finish: "etched",
      condition: "NM",
    });

    // TCG uses tcg_market_foil ("24.00"); MP and P2P prefer tcg_low_foil ("21.00") before tcg_market_foil
    expect(baselines.pRetailTcgUsd).toBe("24.00");
    expect(baselines.pRetailMpUsd).toBe("21.00");
    expect(baselines.pRetailP2pUsd).toBe("21.00");
    // SPEC.md §4.B.1: etched buylist MUST NOT fall back to foil buylist
    expect(baselines.pBuyCkUsd).toBe("0.00");
  });

  it("overrides NM multipliers on fresh 24h sku_price_cache hits and falls back per-channel when buylist_cash_usd is NULL", () => {
    const now = new Date("2026-11-15T12:00:00Z");
    const card = makeCard({
      tcgMarketFoil: "20.00",
      ckBuylistCashFoil: "10.00", // LP foil local fallback = 10.00 * 0.80 * 0.90 = $7.20
    });

    const freshPartialCache: SkuCacheFields = {
      scryfallId: card.scryfallId,
      finish: "foil",
      condition: "LP",
      retailLowUsd: "14.50",
      retailMarketUsd: "15.25",
      buylistCashUsd: null, // Retail-only SKU API response!
      buylistCreditUsd: null,
      source: "tcgapis",
      expiresAt: new Date("2026-11-16T06:00:00Z"),
    };

    const freshResolved = resolveChannelBaselines(
      {
        card,
        finish: "foil",
        condition: "LP",
        skuPriceCache: freshPartialCache,
      },
      { now },
    );

    expect(freshResolved.usedFreshSkuCache).toBe(true);
    expect(freshResolved.pRetailTcgUsd).toBe("15.25"); // Direct from cache without 0.88x
    expect(freshResolved.pRetailP2pUsd).toBe("14.50"); // Direct from cache retail_low_usd
    expect(freshResolved.pBuyCkUsd).toBe("7.20"); // Fell back cleanly to local LP foil buylist!

    // Expired cache (>24h old) is ignored completely
    const expiredCache: SkuCacheFields = {
      ...freshPartialCache,
      expiresAt: new Date("2026-11-15T11:59:59Z"),
    };
    const expiredResolved = resolveChannelBaselines(
      {
        card,
        finish: "foil",
        condition: "LP",
        skuPriceCache: expiredCache,
      },
      { now },
    );
    expect(expiredResolved.usedFreshSkuCache).toBe(false);
    expect(expiredResolved.pRetailTcgUsd).toBe("17.60"); // 20.00 * 0.88
  });

  it("enforces Pro-tier paid SKU API eligibility (NM >= $8.00 OR non-quarantined LP/MP/HP >= $1.00, quota rollover, cache)", () => {
    const now = new Date("2026-11-15T12:00:00Z");
    // $4.00 nonfoil / $40.00 foil card, plus $0.50 bulk card
    const midNonfoilHighFoil = makeCard({
      tcgMarketNm: "4.00",
      tcgMarketFoil: "40.00",
    });
    const subDollarBulk = makeCard({
      tcgMarketNm: "0.50",
      tcgMarketFoil: "0.75",
    });
    const proProfile = {
      monthlySkuApiQuota: 2500,
      monthlySkuApiUsed: 100,
    };

    // LP foil ($40 NM foil baseline >= $8.00) -> ELIGIBLE
    expect(
      evaluatePaidSkuApiEligibility(
        { card: midNonfoilHighFoil, finish: "foil", condition: "LP" },
        proProfile,
      ),
    ).toMatchObject({ eligible: true, nmBaselineUsd: "40.00" });

    // NM foil ($40 NM foil baseline >= $8.00) -> ELIGIBLE under SPEC.md §2.3 OR rule
    expect(
      evaluatePaidSkuApiEligibility(
        { card: midNonfoilHighFoil, finish: "foil", condition: "NM" },
        proProfile,
      ),
    ).toMatchObject({ eligible: true, nmBaselineUsd: "40.00" });

    // NM foil when caller explicitly opts out of high-value NM (`includeHighValueNm: false`) -> SKIPPED
    expect(
      evaluatePaidSkuApiEligibility(
        { card: midNonfoilHighFoil, finish: "foil", condition: "NM" },
        proProfile,
        { includeHighValueNm: false },
      ),
    ).toMatchObject({ eligible: false, skipReason: "near_mint_condition" });

    // NM normal ($4.00 NM baseline < $8.00) -> SKIPPED (resolved locally via card_catalog)
    expect(
      evaluatePaidSkuApiEligibility(
        { card: midNonfoilHighFoil, finish: "normal", condition: "NM" },
        proProfile,
      ),
    ).toMatchObject({
      eligible: false,
      skipReason: "below_nm_price_threshold",
    });

    // LP normal ($4.00 NM baseline >= $1.00, non-NM condition) -> ELIGIBLE
    expect(
      evaluatePaidSkuApiEligibility(
        { card: midNonfoilHighFoil, finish: "normal", condition: "LP" },
        proProfile,
      ),
    ).toMatchObject({ eligible: true, nmBaselineUsd: "4.00" });

    // LP sub-dollar bulk ($0.50 NM baseline < $1.00) -> SKIPPED so quota is never wasted on bulk
    expect(
      evaluatePaidSkuApiEligibility(
        { card: subDollarBulk, finish: "normal", condition: "LP" },
        proProfile,
      ),
    ).toMatchObject({
      eligible: false,
      skipReason: "below_nm_price_threshold",
    });

    // DMG foil -> SKIPPED (quarantined_item)
    expect(
      evaluatePaidSkuApiEligibility(
        { card: midNonfoilHighFoil, finish: "foil", condition: "DMG" },
        proProfile,
      ),
    ).toMatchObject({ eligible: false, skipReason: "quarantined_item" });

    // Exhausted quota in active billing cycle -> SKIPPED (quota_exhausted)
    expect(
      evaluatePaidSkuApiEligibility(
        { card: midNonfoilHighFoil, finish: "foil", condition: "LP" },
        {
          monthlySkuApiQuota: 2500,
          monthlySkuApiUsed: 2500,
          skuApiQuotaResetAt: new Date("2026-12-01T00:00:00Z"),
        },
        { now },
      ),
    ).toMatchObject({ eligible: false, skipReason: "quota_exhausted" });

    // Elapsed skuApiQuotaResetAt (`<= now`) rolls monthly usage back to 0 -> ELIGIBLE
    expect(
      evaluatePaidSkuApiEligibility(
        { card: midNonfoilHighFoil, finish: "foil", condition: "LP" },
        {
          monthlySkuApiQuota: 2500,
          monthlySkuApiUsed: 2500,
          skuApiQuotaResetAt: new Date("2026-11-01T00:00:00Z"),
        },
        { now },
      ),
    ).toMatchObject({ eligible: true });
  });

  it("ignores '0.00' retail placeholders during coalescing and preserves custom catalog credit on retail-only SKU cache hits", () => {
    const now = new Date("2026-11-15T12:00:00Z");
    const card = makeCard({
      tcgMarketNm: "12.00",
      manapoolLowNm: "0.00",
      tcgLowNm: "0.00",
      ckBuylistCashNm: "6.00",
      ckBuylistCreditNm: "6.00", // Custom 1.00x store credit instead of 1.30x
    });

    const localBaselines = resolveChannelBaselines({ card });
    expect(localBaselines.pRetailMpUsd).toBe("12.00");
    expect(localBaselines.pRetailP2pUsd).toBe("12.00");

    const retailOnlyCacheHit = evaluateCardRouting(
      {
        card,
        skuPriceCache: {
          scryfallId: card.scryfallId,
          finish: "normal",
          condition: "NM",
          retailLowUsd: "0.00",
          retailMarketUsd: "11.50",
          buylistCashUsd: null,
          buylistCreditUsd: null,
          source: "tcgapis",
          expiresAt: new Date("2026-11-16T00:00:00Z"),
        },
      },
      { enableCreditArbitrage: true },
      { now },
    );
    expect(retailOnlyCacheHit.baselines.pRetailMpUsd).toBe("11.50");
    // Custom catalog credit $6.00 * 0.82 = $4.92 (NOT $6.00 * 1.066 = $6.40)
    expect(retailOnlyCacheHit.nets.netCkCreditUsd).toBe("4.92");
  });
});

describe("Exact Per-Card Fee & Payout Formulas", () => {
  it("computes Net_TCG, Net_MP, Net_P2P, Net_Conduit_{Sorted,Curated,Standard}, and Net_Credit_Arb to the exact cent", () => {
    const card = makeCard({
      tcgMarketNm: "10.00",
      manapoolLowNm: "10.00",
      tcgLowNm: "10.00",
      ckBuylistCashNm: "6.00",
      ckBuylistCreditNm: "7.80",
    });

    const baselines = resolveChannelBaselines({ card });
    const nets = computeChannelNets(baselines, { card }, DEFAULT_ROUTING_PROFILE);

    // Net_TCG = 10.00 - 1.075 - 0.25 - 0.30 - 0.90 - 1.00 = 6.475 -> $6.48
    expect(nets.netTcgplayerSingleUsd).toBe("6.48");
    // Net_MP = 10.00 * 0.921 - 0.30 - 0.90 - 1.00 = 9.21 - 2.20 = $7.01
    expect(nets.netManapoolSingleUsd).toBe("7.01");
    // Net_P2P = (10.00 * 0.85) * 0.965 - 0.90 - 0.50 = 8.2025 - 1.40 = 6.8025 -> $6.80
    expect(nets.netP2p85PctUsd).toBe("6.80");
    // Buylist nets on $6.00:
    expect(nets.netCkCashUsd).toBe("6.00");
    expect(nets.netConduitSortedUsd).toBe("5.88"); // 6.00 * 0.98
    expect(nets.netConduitCuratedUsd).toBe("5.70"); // 6.00 * 0.95
    expect(nets.netConduitStandardUsd).toBe("5.37"); // 6.00 * 0.90 - 0.03
    // Credit arb: (6.00 * 1.30) * 0.82 = 6.396 -> $6.40
    expect(nets.netCkCreditUsd).toBe("6.40");
  });

  it("enforces the $75.00 TCGplayer 10.75% commission cap at the $697.67 / $697.68 crossover", () => {
    // At $697.67: 697.67 * 0.1075 = $74.999525 (just below $75.00 cap)
    // Net = 697.67 * 0.8675 - 0.30 - 4.25 - 1.00 = 605.228725 - 5.55 = 599.678725 -> $599.68
    const belowCap = evaluateCardRouting({
      card: makeCard({ tcgMarketNm: "697.67", ckBuylistCashNm: "400.00" }),
    });
    expect(belowCap.nets.netTcgplayerSingleUsd).toBe("599.68");

    // At $697.68: 697.68 * 0.1075 = $75.0006 -> capped at exactly $75.00!
    // Net_TCG = 697.68 - 75.00 - (697.68 * 0.025 = 17.442) - 0.30 - 4.25 - 1.00 = 599.688 -> $599.69
    const exactCapCrossover = evaluateCardRouting({
      card: makeCard({ tcgMarketNm: "697.68", ckBuylistCashNm: "400.00" }),
    });
    expect(exactCapCrossover.nets.netTcgplayerSingleUsd).toBe("599.69");

    // At $800.00: 10.75% uncapped would be $86.00, capped at $75.00!
    // Net_TCG = 800.00 - 75.00 - (800.00 * 0.025 = 20.00) - 0.30 - 4.25 - 1.00 = $699.45
    const aboveCap = evaluateCardRouting({
      card: makeCard({ tcgMarketNm: "800.00", ckBuylistCashNm: "450.00" }),
    });
    expect(aboveCap.nets.netTcgplayerSingleUsd).toBe("699.45");
  });

  it("evaluates C_ship per channel sale price (including exact $24.99 vs $25.00 cutoff and P2P 85% claim sale price)", () => {
    const at2499 = evaluateCardRouting({
      card: makeCard({ tcgMarketNm: "24.99", manapoolLowNm: "24.99" }),
    });
    expect(at2499.nets.shipTcgUsd).toBe("0.90");
    expect(at2499.nets.shipMpUsd).toBe("0.90");

    const at2500 = evaluateCardRouting({
      card: makeCard({ tcgMarketNm: "25.00", manapoolLowNm: "25.00" }),
    });
    expect(at2500.nets.shipTcgUsd).toBe("4.25");
    expect(at2500.nets.shipMpUsd).toBe("4.25");
    // At $28.00 retail: TCG & MP >= $25.00 ($4.25 tracked), while P2P sale price = $28 * 0.85 = $23.80 < $25.00 ($0.90 PWE)!
    const res = evaluateCardRouting({
      card: makeCard({
        tcgMarketNm: "28.00",
        manapoolLowNm: "28.00",
        tcgLowNm: "28.00",
        ckBuylistCashNm: "12.00",
      }),
    });
    expect(res.nets.shipTcgUsd).toBe("4.25");
    expect(res.nets.shipMpUsd).toBe("4.25");
    expect(res.nets.shipP2pUsd).toBe("0.90");
  });

  it("clamps Net_Conduit_Standard at $0.00 when P_buy * 0.90 < $0.03", () => {
    const tiny = evaluateCardRouting({
      card: makeCard({ tcgMarketNm: "0.20", ckBuylistCashNm: "0.02" }),
    });
    expect(tiny.nets.netConduitStandardUsd).toBe("0.00");
  });
});

describe("Strict 4-Bucket Decision Tree Order (SPEC.md §4.C)", () => {
  it("routes Step 1 PILE_4_BULK into binder_local ($0.50+) vs bulk_wholesale (<$0.50)", () => {
    const binderCard = evaluateCardRouting({
      card: makeCard({ tcgMarketNm: "1.20", ckBuylistCashNm: "0.25" }),
    });
    expect(binderCard.assignedBucket).toBe("PILE_4_BULK");
    expect(binderCard.recommendedChannel).toBe("binder_local");
    expect(binderCard.optimalUnitNetUsd).toBe("0.00");

    const draftChaff = evaluateCardRouting({
      card: makeCard({ tcgMarketNm: "0.15", ckBuylistCashNm: null }),
    });
    expect(draftChaff.assignedBucket).toBe("PILE_4_BULK");
    expect(draftChaff.recommendedChannel).toBe("bulk_wholesale");
  });

  it("evaluates Step 2 PILE_3_CREDIT_ARB BEFORE Step 3 PILE_1_BUYLIST when enableCreditArbitrage is true", () => {
    // Card at $10.00 retail -> Net_BestSingle = $7.01 (MP).
    // CK Cash = $5.60 -> Net_BestSingle - Net_Buylist_Cash = $7.01 - $5.60 = $1.41 >= $1.25 (would miss cash buylist!)
    // CK Credit Arb = $5.60 * 1.066 = $5.97 -> Net_BestSingle - Net_Credit_Arb = $7.01 - $5.97 = $1.04 < $1.25!
    const card = makeCard({
      tcgMarketNm: "10.00",
      manapoolLowNm: "10.00",
      ckBuylistCashNm: "5.60",
      ckBuylistCreditNm: "7.28",
    });

    const withoutArb = evaluateCardRouting(
      { card },
      { enableCreditArbitrage: false },
    );
    expect(withoutArb.assignedBucket).toBe("PILE_2_SINGLES");

    const withArb = evaluateCardRouting(
      { card },
      { enableCreditArbitrage: true },
    );
    expect(withArb.assignedBucket).toBe("PILE_3_CREDIT_ARB");
    expect(withArb.recommendedChannel).toBe("ck_credit");
    expect(withArb.optimalUnitNetUsd).toBe("5.97");
  });

  it("routes Step 3 PILE_1_BUYLIST when P_buy >= $0.50 and single margin < minSingleNetGainOverBuylistUsd", () => {
    const buylistWinner = evaluateCardRouting({
      card: makeCard({
        tcgMarketNm: "6.00",
        manapoolLowNm: "6.00",
        ckBuylistCashNm: "3.50",
      }),
    });
    // Net_MP = 6*0.921 - 2.20 = $3.33; Net_P2P = 6*0.85*0.965 - 1.40 = $3.52; Net_CK_Cash = $3.50
    // $3.52 - $3.50 = $0.02 < $1.25 -> PILE_1_BUYLIST
    expect(buylistWinner.assignedBucket).toBe("PILE_1_BUYLIST");
    expect(buylistWinner.recommendedChannel).toBe("ck_cash");
    expect(buylistWinner.optimalUnitNetUsd).toBe("3.50");
  });

  it("selects Card Conduit tier when multi-vendor Conduit quote beats CK direct or buylistCashMode is conduit", () => {
    const multiVendor = evaluateCardRouting(
      {
        card: makeCard({
          tcgMarketNm: "8.00",
          ckBuylistCashNm: "4.00",
        }),
        conduitBuylistCashUsd: "5.00",
      },
      { conduitTierPreference: "sorted" },
    );
    // Conduit Sorted = 5.00 * 0.98 = $4.90 > CK $4.00
    expect(multiVendor.assignedBucket).toBe("PILE_1_BUYLIST");
    expect(multiVendor.recommendedChannel).toBe("conduit_sorted");
    expect(multiVendor.optimalUnitNetUsd).toBe("4.90");
  });
});

describe("Lot-Level Outbound Box Postage Guardrail & Schedule C COGS Allocation", () => {
  it("combines PILE_1_BUYLIST (ck_cash) + PILE_3_CREDIT_ARB (ck_credit) into ONE $12.00 Card Kingdom box", () => {
    // Card 1: CK Credit Arb winner (10 copies @ $6.80 CK cash -> $7.25 credit arb net vs $7.01 MP single)
    const creditCard = makeCard({
      scryfallId: "11111111-1111-4111-8111-111111111111",
      tcgMarketNm: "10.00",
      manapoolLowNm: "10.00",
      ckBuylistCashNm: "6.80",
      ckBuylistCreditNm: "8.84",
    });

    // Card 2: CK Cash winner when credit arb is overridden below cash via explicit SKU cache credit = $5.00
    // (10 copies @ $5.00 CK cash vs $3.52 P2P single -> +$14.80 gain over singles)
    const cashCard = makeCard({
      scryfallId: "22222222-2222-4222-8222-222222222222",
      tcgMarketNm: "6.00",
      manapoolLowNm: "6.00",
      ckBuylistCashNm: "5.00",
    });

    const now = new Date("2026-11-15T12:00:00Z");
    const lot = routeCollectionLot({
      purchaseCostUsd: "80.00",
      profile: { enableCreditArbitrage: true },
      options: { now },
      items: [
        { card: creditCard, quantity: 10 },
        {
          card: cashCard,
          quantity: 10,
          skuPriceCache: {
            scryfallId: cashCard.scryfallId,
            finish: "normal",
            condition: "NM",
            retailLowUsd: "6.00",
            retailMarketUsd: "6.00",
            buylistCashUsd: "5.00",
            buylistCreditUsd: "5.00", // 5.00 * 0.82 = 4.10 < 5.00 cash -> routes to ck_cash!
            source: "tcgapis",
            expiresAt: new Date("2026-11-16T00:00:00Z"),
          },
        },
      ],
    });

    expect(lot.summary.buckets.PILE_3_CREDIT_ARB.totalCards).toBe(10);
    expect(lot.summary.buckets.PILE_1_BUYLIST.totalCards).toBe(10);
    // Both ship to Card Kingdom -> only ONE $12.00 box!
    expect(lot.summary.outboundBoxCount).toBe(1);
    expect(lot.summary.outboundBoxShippingUsd).toBe("12.00");
    // Subtotal = 10 * 7.25 + 10 * 5.00 = 72.50 + 50.00 = $122.50; Net after $12 box = $110.50
    expect(lot.summary.subtotalItemNetPayoutUsd).toBe("122.50");
    expect(lot.summary.estimatedNetPayoutUsd).toBe("110.50");
    expect(lot.summary.estimatedNetProfitUsd).toBe("30.50");
    expect(lot.summary.estimatedNetRoiPct).toBe("38.13");
  });

  it("charges two $12.00 boxes ($24.00) when both Card Conduit and Card Kingdom earn >$12.00 incremental margin", () => {
    // 10x Conduit Sorted winner ($6.00 multi-vendor quote * 0.98 = $5.88 > CK $4.00 & CK Credit $4.26 -> +$16.20 over CK > $12 box)
    const conduitCard = makeCard({
      scryfallId: "33333333-3333-4333-8333-333333333333",
      tcgMarketNm: "6.00",
      manapoolLowNm: "6.00",
      ckBuylistCashNm: "4.00",
    });

    // 25x CK Credit Arb winner ($6.80 CK cash -> $7.25 credit arb vs $6.66 Conduit Sorted -> 25 * $0.59 = +$14.75 over Conduit > $12 box)
    const ckCreditCard = makeCard({
      scryfallId: "44444444-4444-4444-8444-444444444444",
      tcgMarketNm: "8.80",
      manapoolLowNm: "8.80",
      ckBuylistCashNm: "6.80",
    });

    const lot = routeCollectionLot({
      purchaseCostUsd: "120.00",
      profile: {
        enableCreditArbitrage: true,
        conduitTierPreference: "sorted",
      },
      items: [
        { card: conduitCard, quantity: 10, conduitBuylistCashUsd: "6.00" },
        { card: ckCreditCard, quantity: 25 },
      ],
    });

    expect(lot.summary.buckets.PILE_1_BUYLIST.totalCards).toBe(10);
    expect(lot.summary.buckets.PILE_3_CREDIT_ARB.totalCards).toBe(25);
    expect(lot.summary.outboundBoxCount).toBe(2);
    expect(lot.summary.outboundBoxShippingUsd).toBe("24.00");
  });

  it("cascades tiny unviable vendor boxes into the surviving buylist vendor (Conduit -> CK Credit/Cash and CK Credit -> Conduit) rather than dumping to Singles/Bulk", () => {
    // Case A: 20x viable CK Credit cards + 2x tiny Conduit cards ($5.88 Conduit vs $5.86 CK Credit vs $3.52 P2P Single)
    // Keeping a 2nd $12 Conduit box for 2 cards loses money; dumping to Singles ($3.52) wastes $2.34/card; cascading into the existing CK box earns $5.86/card with $0 extra box postage!
    const viableCkCard = makeCard({
      scryfallId: "55555555-5555-4555-8555-555555555555",
      tcgMarketNm: "8.80",
      manapoolLowNm: "8.80",
      ckBuylistCashNm: "6.80",
    });
    const tinyConduitCard = makeCard({
      scryfallId: "66666666-6666-4666-8666-666666666666",
      tcgMarketNm: "6.00",
      manapoolLowNm: "6.00",
      ckBuylistCashNm: "5.50", // CK Credit = $5.50 * 1.066 = $5.86
    });

    const cascadedToCk = routeCollectionLot({
      purchaseCostUsd: "100.00",
      profile: {
        enableCreditArbitrage: true,
        conduitTierPreference: "sorted",
      },
      items: [
        { card: viableCkCard, quantity: 20, conduitBuylistCashUsd: "4.00" },
        { card: tinyConduitCard, quantity: 2, conduitBuylistCashUsd: "6.00" },
      ],
    });

    expect(cascadedToCk.summary.outboundBoxCount).toBe(1);
    expect(cascadedToCk.summary.outboundBoxShippingUsd).toBe("12.00");
    expect(cascadedToCk.items[1]!.initialRecommendedChannel).toBe(
      "conduit_sorted",
    );
    expect(cascadedToCk.items[1]!.assignedBucket).toBe("PILE_3_CREDIT_ARB");
    expect(cascadedToCk.items[1]!.recommendedChannel).toBe("ck_credit");
    expect(cascadedToCk.items[1]!.optimalUnitNetUsd).toBe("5.86");
    expect(cascadedToCk.items[1]!.demotedFromBuylistByPostageGuard).toBe(true);

    // Case B: 30x viable Conduit Sorted cards + 1x cheap CK Credit card ($1.00 retail -> Net_BestSingle < $0.75 so non-buylist fallback is $0.00 Bulk, CK cash $1.00 -> $1.07 credit vs $0.98 Conduit Sorted)
    // Cascading that 1 card into the open Conduit box rescues $0.98 instead of demoting it to $0.00 PILE_4_BULK!
    const viableConduitCard = makeCard({
      scryfallId: "77777777-7777-4777-8777-777777777777",
      tcgMarketNm: "6.00",
      manapoolLowNm: "6.00",
      ckBuylistCashNm: "3.00",
    });
    const loneCkCreditCard = makeCard({
      scryfallId: "88888888-8888-4888-8888-888888888888",
      tcgMarketNm: "1.50",
      manapoolLowNm: "1.50",
      ckBuylistCashNm: "1.00",
    });

    const cascadedToConduit = routeCollectionLot({
      purchaseCostUsd: "60.00",
      profile: {
        enableCreditArbitrage: true,
        conduitTierPreference: "sorted",
      },
      items: [
        {
          card: viableConduitCard,
          quantity: 30,
          conduitBuylistCashUsd: "5.50",
        },
        { card: loneCkCreditCard, quantity: 1 },
      ],
    });

    expect(cascadedToConduit.summary.outboundBoxCount).toBe(1);
    expect(cascadedToConduit.items[1]!.initialAssignedBucket).toBe(
      "PILE_3_CREDIT_ARB",
    );
    expect(cascadedToConduit.items[1]!.assignedBucket).toBe("PILE_1_BUYLIST");
    expect(cascadedToConduit.items[1]!.recommendedChannel).toBe(
      "conduit_sorted",
    );
    expect(cascadedToConduit.items[1]!.optimalUnitNetUsd).toBe("0.98");
  });

  it("demotes tiny single-vendor buylist piles (including exact $12.00 postage ties) to non-buylist fallbacks", () => {
    // Tiny buylist lot: 2 copies @ $3.00 CK Cash ($6.00 gross buylist) vs $2.52 P2P single ($5.04 fallback)
    // Buylist after $12 box = -$6.00 <= $5.04 -> MUST demote to PILE_2_SINGLES!
    const tinyCard = makeCard({
      tcgMarketNm: "4.80",
      ckBuylistCashNm: "3.00",
    });

    const demotedLot = routeCollectionLot({
      purchaseCostUsd: "4.00",
      items: [{ card: tinyCard, quantity: 2 }],
    });

    expect(demotedLot.items[0]!.initialAssignedBucket).toBe("PILE_1_BUYLIST");
    expect(demotedLot.items[0]!.demotedFromBuylistByPostageGuard).toBe(true);
    expect(demotedLot.items[0]!.assignedBucket).toBe("PILE_2_SINGLES");
    expect(demotedLot.summary.outboundBoxCount).toBe(0);
    expect(demotedLot.summary.outboundBoxShippingUsd).toBe("0.00");

    // Exact tie: 12 copies @ $1.00 CK Cash ($12.00 gross buylist) vs $0.00 Bulk fallback, $12.00 box shipping -> $12 - $12 === $0 -> demotes on `<=`!
    const exactTieLot = routeCollectionLot({
      purchaseCostUsd: "5.00",
      items: [
        {
          card: makeCard({ tcgMarketNm: "1.50", ckBuylistCashNm: "1.00" }),
          quantity: 12,
        },
      ],
    });
    expect(exactTieLot.summary.outboundBoxCount).toBe(0);
    expect(exactTieLot.items[0]!.assignedBucket).toBe("PILE_4_BULK");
  });

  it("allocates cent-exact line-item IRS Schedule C COGS summing to purchaseCostUsd across equal, prime-quantity, and bulk rows", () => {
    // 1. Classic 3-way split ($100.00 across three 1x $10.00 items -> $33.34 + $33.33 + $33.33 = $100.00)
    const threeWay = routeCollectionLot({
      purchaseCostUsd: "100.00",
      items: [
        { card: makeCard({ scryfallId: "00000000-0000-4000-8000-000000000001", tcgMarketNm: "10.00" }) },
        { card: makeCard({ scryfallId: "00000000-0000-4000-8000-000000000002", tcgMarketNm: "10.00" }) },
        { card: makeCard({ scryfallId: "00000000-0000-4000-8000-000000000003", tcgMarketNm: "10.00" }) },
      ],
    });
    expect(threeWay.items.map((i) => i.allocatedCostBasisUsd)).toEqual([
      "33.34",
      "33.33",
      "33.33",
    ]);
    expect(threeWay.summary.allocatedCostBasisSumUsd).toBe("100.00");

    // 2. Mixed quantities: Row 1 has 2x $10 ($20 FMV = 66.67%), Row 2 has 1x $10 ($10 FMV = 33.33%), purchaseCost = $10.00
    // Largest-Remainder (Hamilton) line-item bases: $6.67 + $3.33 = $10.00 exact!
    const mixedQty = allocateScheduleCCostBasis(1000n, [
      { quantity: 2, unitFmvCents: 1000n },
      { quantity: 1, unitFmvCents: 1000n },
    ]);
    expect(mixedQty[0]).toEqual({
      unitCostBasisCents: 334n,
      totalCostBasisCents: 667n,
    });
    expect(mixedQty[1]).toEqual({
      unitCostBasisCents: 333n,
      totalCostBasisCents: 333n,
    });

    // 3. Prime-quantity 3x row on $10.00 lot + 1,000x bulk row on $3.00 lot:
    // Persisted `toNewLotItems` `allocatedCostBasisUsd` reconciles cent-for-cent to `purchaseCostUsd` without losing COGS!
    const primeQtyLot = routeCollectionLot({
      purchaseCostUsd: "10.00",
      items: [{ card: makeCard({ tcgMarketNm: "5.00" }), quantity: 3 }],
    });
    expect(primeQtyLot.items[0]!.allocatedCostBasisUsd).toBe("10.00");
    expect(primeQtyLot.items[0]!.unitAllocatedCostBasisUsd).toBe("3.33");
    expect(
      primeQtyLot.toNewLotItems("lot-1")[0]!.allocatedCostBasisUsd,
    ).toBe("10.00");

    const highQtyBulkLot = routeCollectionLot({
      purchaseCostUsd: "3.00",
      items: [{ card: makeCard({ tcgMarketNm: "0.10", ckBuylistCashNm: null }), quantity: 1000 }],
    });
    expect(highQtyBulkLot.items[0]!.allocatedCostBasisUsd).toBe("3.00");
    expect(highQtyBulkLot.items[0]!.unitAllocatedCostBasisUsd).toBe("0.00");

    // Partial-row tax-period sale split preserves exact cent sum (`$3.33 + $6.67 === $10.00`)
    expect(splitAllocatedCostBasis(1000n, 3, 1)).toEqual({
      soldCostBasisCents: 333n,
      remainingCostBasisCents: 667n,
    });

    // 4. Zero-FMV lot -> $0.00 basis without division by zero
    const zeroFmv = allocateScheduleCCostBasis(5000n, [
      { quantity: 4, unitFmvCents: 0n },
    ]);
    expect(zeroFmv[0]).toEqual({
      unitCostBasisCents: 0n,
      totalCostBasisCents: 0n,
    });
  });
});
