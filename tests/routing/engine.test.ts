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
    expect(formatCentsToUsd(-85n)).toBe("-0.85");
    expect(parseUsdToCents(null)).toBeNull();
    expect(parseUsdToCents("   ")).toBeNull();
    expect(() => parseUsdToCents("abc")).toThrow(SyntaxError);
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

  it("enforces Pro-tier paid SKU API eligibility (finish-specific NM >= $8.00, non-NM, non-DMG, quota, cache)", () => {
    // $1.00 nonfoil / $40.00 foil card
    const foilStaple = makeCard({
      tcgMarketNm: "1.00",
      tcgMarketFoil: "40.00",
    });
    const proProfile = {
      monthlySkuApiQuota: 2500,
      monthlySkuApiUsed: 100,
    };

    // LP foil ($40 NM foil baseline >= $8.00) -> ELIGIBLE
    expect(
      evaluatePaidSkuApiEligibility(
        { card: foilStaple, finish: "foil", condition: "LP" },
        proProfile,
      ),
    ).toMatchObject({ eligible: true, nmBaselineUsd: "40.00" });

    // LP normal ($1.00 NM baseline < $8.00) -> SKIPPED (below_nm_price_threshold)
    expect(
      evaluatePaidSkuApiEligibility(
        { card: foilStaple, finish: "normal", condition: "LP" },
        proProfile,
      ),
    ).toMatchObject({
      eligible: false,
      skipReason: "below_nm_price_threshold",
    });

    // NM foil -> SKIPPED (near_mint_condition)
    expect(
      evaluatePaidSkuApiEligibility(
        { card: foilStaple, finish: "foil", condition: "NM" },
        proProfile,
      ),
    ).toMatchObject({ eligible: false, skipReason: "near_mint_condition" });

    // DMG foil -> SKIPPED (quarantined_item)
    expect(
      evaluatePaidSkuApiEligibility(
        { card: foilStaple, finish: "foil", condition: "DMG" },
        proProfile,
      ),
    ).toMatchObject({ eligible: false, skipReason: "quarantined_item" });

    // Exhausted quota -> SKIPPED (quota_exhausted)
    expect(
      evaluatePaidSkuApiEligibility(
        { card: foilStaple, finish: "foil", condition: "LP" },
        { monthlySkuApiQuota: 2500, monthlySkuApiUsed: 2500 },
      ),
    ).toMatchObject({ eligible: false, skipReason: "quota_exhausted" });
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

    // At $800.00: 10.75% uncapped would be $86.00, capped at $75.00!
    // Net_TCG = 800.00 - 75.00 - (800.00 * 0.025 = 20.00) - 0.30 - 4.25 - 1.00 = $699.45
    const aboveCap = evaluateCardRouting({
      card: makeCard({ tcgMarketNm: "800.00", ckBuylistCashNm: "450.00" }),
    });
    expect(aboveCap.nets.netTcgplayerSingleUsd).toBe("699.45");
  });

  it("evaluates C_ship per channel sale price (including P2P 85% claim sale price vs $25.00 threshold)", () => {
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

  it("charges two $12.00 boxes ($24.00) when PILE_1_BUYLIST ships to Card Conduit and PILE_3_CREDIT_ARB ships to Card Kingdom", () => {
    // 10x Conduit Sorted winner ($6.00 multi-vendor quote * 0.98 = $5.88 > CK $4.00 & CK Credit $4.26, vs $3.52 P2P single)
    const conduitCard = makeCard({
      scryfallId: "33333333-3333-4333-8333-333333333333",
      tcgMarketNm: "6.00",
      manapoolLowNm: "6.00",
      ckBuylistCashNm: "4.00",
    });

    // 20x CK Credit Arb winner ($6.80 CK cash -> $7.25 credit arb vs $5.80 P2P single -> +$29.00 over singles > $12 box)
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
        { card: ckCreditCard, quantity: 20 },
      ],
    });

    expect(lot.summary.buckets.PILE_1_BUYLIST.totalCards).toBe(10);
    expect(lot.summary.buckets.PILE_3_CREDIT_ARB.totalCards).toBe(20);
    expect(lot.summary.outboundBoxCount).toBe(2);
    expect(lot.summary.outboundBoxShippingUsd).toBe("24.00");
  });

  it("charges two $12.00 boxes when shipping to both Card Conduit and Card Kingdom, and demotes tiny buylist piles whose gain cannot cover postage", () => {
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
  });

  it("allocates cent-exact IRS Schedule C COGS summing to purchaseCostUsd across equal, uneven, and multi-quantity rows", () => {
    // 1. Classic 3-way split ($100.00 across three $10.00 items -> $33.34 + $33.33 + $33.33 = $100.00)
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

    // 2. Mixed quantities: Row 1 has 2x $10, Row 2 has 1x $10, purchaseCost = $10.00
    // Unit bases: $3.33 (x2 = $6.66) + $3.34 (x1 = $3.34) = $10.00 exact!
    const mixedQty = allocateScheduleCCostBasis(1000n, [
      { quantity: 2, unitFmvCents: 1000n },
      { quantity: 1, unitFmvCents: 1000n },
    ]);
    expect(mixedQty[0]).toEqual({
      unitCostBasisCents: 333n,
      totalCostBasisCents: 666n,
    });
    expect(mixedQty[1]).toEqual({
      unitCostBasisCents: 334n,
      totalCostBasisCents: 334n,
    });

    // 3. Zero-FMV lot -> $0.00 basis without division by zero
    const zeroFmv = allocateScheduleCCostBasis(5000n, [
      { quantity: 4, unitFmvCents: 0n },
    ]);
    expect(zeroFmv[0]).toEqual({
      unitCostBasisCents: 0n,
      totalCostBasisCents: 0n,
    });
  });
});
