import { describe, expect, it } from "vitest";
import {
  CARD_CONDUIT_HEADERS,
  CARD_KINGDOM_BUYLIST_SPEC_HEADERS,
  CARD_KINGDOM_BUYLIST_TITLE_HEADERS,
  CardConduitValidationError,
  type ExportableLotItem,
  exportCardConduitCsv,
  exportCardKingdomBuylistCsv,
  exportManapoolStagedCsv,
  exportP2pClaimMarkdown,
  exportTcgplayerStagedCsv,
  generateAllLotExports,
  MANAPOOL_STAGED_HEADERS,
  TCGPLAYER_STAGED_HEADERS,
} from "@/lib/csv/exports";
import { parseCsvMatrix } from "@/lib/csv/parser";
import { routeCollectionLot } from "@/lib/routing/engine";
import type { CatalogPriceFields } from "@/lib/routing/types";

function makeCatalogCard(
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
    tcgMarketNm: "5.00",
    tcgLowNm: "4.60",
    tcgMarketFoil: "12.00",
    tcgLowFoil: "11.00",
    tcgMarketEtched: "18.00",
    tcgLowEtched: "16.50",
    manapoolLowNm: "4.80",
    manapoolLowFoil: "11.50",
    manapoolLowEtched: "17.00",
    ckBuylistCashNm: "3.00",
    ckBuylistCreditNm: "3.90",
    ckBuylistCashFoil: "7.00",
    ckBuylistCreditFoil: "9.10",
    ckBuylistCashEtched: "10.00",
    ckBuylistCreditEtched: "13.00",
    ...overrides,
  };
}

function makeConduitStubItem(params: {
  name: string;
  scryfallId: string;
  quantity: number;
  pBuyCents: bigint;
}): ExportableLotItem {
  return {
    card: makeCatalogCard({
      name: params.name,
      scryfallId: params.scryfallId,
    }),
    finish: "normal",
    condition: "NM",
    language: "en",
    isAltered: false,
    isMisprint: false,
    quantity: params.quantity,
    assignedBucket: "PILE_1_BUYLIST",
    recommendedChannel: "conduit_curated",
    baselines: {
      pRetailTcgUsd: "5.00",
      pRetailMpUsd: "4.80",
      pRetailP2pUsd: "4.60",
      pSaleP2pClaimUsd: "3.91",
      pBuyCkCents: params.pBuyCents,
      pBuyConduitCents: params.pBuyCents,
    },
  };
}

describe("Card Conduit CSV Exporter & Validation Gates", () => {
  it("enforces the >= 90% P_buy >= $0.50 validation gate on Curated exports", () => {
    // 89 eligible ($1.00) + 11 sub-$0.50 ($0.40) = 89.00% < 90.00% -> throws CardConduitValidationError
    const failingCurated = [
      makeConduitStubItem({
        name: "Mid Value",
        scryfallId: "00000000-0000-4000-8000-000000000001",
        quantity: 89,
        pBuyCents: 100n,
      }),
      makeConduitStubItem({
        name: "Sub Fifty",
        scryfallId: "00000000-0000-4000-8000-000000000002",
        quantity: 11,
        pBuyCents: 40n,
      }),
    ];

    expect(() =>
      exportCardConduitCsv(failingCurated, { tier: "curated" }),
    ).toThrow(CardConduitValidationError);

    // 90 eligible + 10 sub-$0.50 = 90.00% -> passes Curated, but fails Sorted (which requires 100%)
    const boundaryCurated = [
      makeConduitStubItem({
        name: "Mid Value",
        scryfallId: "00000000-0000-4000-8000-000000000001",
        quantity: 90,
        pBuyCents: 100n,
      }),
      makeConduitStubItem({
        name: "Sub Fifty",
        scryfallId: "00000000-0000-4000-8000-000000000002",
        quantity: 10,
        pBuyCents: 40n,
      }),
    ];

    const curatedRes = exportCardConduitCsv(boundaryCurated, {
      tier: "curated",
    });
    expect(curatedRes.validation.valid).toBe(true);
    expect(curatedRes.totalCards).toBe(100);
    expect(curatedRes.batches).toHaveLength(1);
    expect(curatedRes.batches[0]!.filename).toBe("card-conduit-curated.csv");

    expect(() =>
      exportCardConduitCsv(boundaryCurated, { tier: "sorted" }),
    ).toThrow(CardConduitValidationError);
  });

  it("sorts Sorted exports descending by P_buy and splits >500 total cards into numbered batches", () => {
    // Total = 320 + 250 + 550 = 1,120 cards -> 3 batches (500 + 500 + 120)
    const items = [
      makeConduitStubItem({
        name: "Card Low ($1.00)",
        scryfallId: "00000000-0000-4000-8000-000000000003",
        quantity: 550,
        pBuyCents: 100n,
      }),
      makeConduitStubItem({
        name: "Card High ($15.00)",
        scryfallId: "00000000-0000-4000-8000-000000000001",
        quantity: 320,
        pBuyCents: 1500n,
      }),
      makeConduitStubItem({
        name: "Card Mid ($5.00)",
        scryfallId: "00000000-0000-4000-8000-000000000002",
        quantity: 250,
        pBuyCents: 500n,
      }),
    ];

    const sortedRes = exportCardConduitCsv(items, { tier: "sorted" });
    expect(sortedRes.totalCards).toBe(1120);
    expect(sortedRes.batches).toHaveLength(3);

    expect(sortedRes.batches[0]).toMatchObject({
      batchNumber: 1,
      filename: "card-conduit-sorted-batch-1.csv",
      totalCards: 500,
    });
    expect(sortedRes.batches[1]).toMatchObject({
      batchNumber: 2,
      filename: "card-conduit-sorted-batch-2.csv",
      totalCards: 500,
    });
    expect(sortedRes.batches[2]).toMatchObject({
      batchNumber: 3,
      filename: "card-conduit-sorted-batch-3.csv",
      totalCards: 120,
    });

    // Verify Batch 1 starts with Card High (320) followed by 180 copies of Card Mid
    const parsedBatch1 = parseCsvMatrix(sortedRes.batches[0]!.csv);
    expect(parsedBatch1.headers).toEqual([...CARD_CONDUIT_HEADERS]);
    expect(parsedBatch1.records[0]!.values[0]).toBe("320");
    expect(parsedBatch1.records[0]!.values[1]).toBe("Card High ($15.00)");
    expect(parsedBatch1.records[1]!.values[0]).toBe("180");
    expect(parsedBatch1.records[1]!.values[1]).toBe("Card Mid ($5.00)");
  });
});

describe("Card Kingdom, TCGplayer, Mana Pool, & Discord/FB Claim Sale Exporters", () => {
  it("exports all 5 formats accurately from a routed multi-channel lot", () => {
    // 1. CK Cash Buylist card ($6.00 retail, $4.50 CK cash, explicit low credit override)
    const ckCashCard = makeCatalogCard({
      scryfallId: "10000000-0000-4000-8000-000000000001",
      name: "Counterspell",
      setCode: "mh2",
      setName: "Modern Horizons 2",
      collectorNumber: "267",
      tcgMarketFoil: "6.00",
      manapoolLowFoil: "6.00",
      tcgLowFoil: "6.00",
      ckBuylistCashFoil: "4.50",
      ckBuylistCreditFoil: "4.50",
    });

    // 2. CK Store Credit Arb card ($10.00 retail, $6.80 CK cash -> $7.25 credit arb vs $7.01 MP)
    const ckCreditCard = makeCatalogCard({
      scryfallId: "10000000-0000-4000-8000-000000000002",
      name: "Swords to Plowshares",
      setCode: "2x2",
      setName: "Double Masters 2022",
      collectorNumber: "31",
      tcgMarketEtched: "10.00",
      manapoolLowEtched: "10.00",
      tcgLowEtched: "10.00",
      ckBuylistCashEtched: "6.80",
      ckBuylistCreditEtched: "8.84",
    });

    // 3. TCGplayer Single winner (high tcgMarketEtched $35.00 vs lower MP/Low $20.00, CK cash $8.00)
    const tcgSingleCard = makeCatalogCard({
      scryfallId: "10000000-0000-4000-8000-000000000003",
      name: "Jace, the Mind Sculptor",
      setCode: "2xm",
      setName: "Double Masters",
      collectorNumber: "56",
      rarity: "mythic",
      tcgplayerId: 218001,
      tcgplayerEtchedId: 218002,
      tcgMarketEtched: "35.00",
      tcgLowEtched: "20.00",
      manapoolLowEtched: "20.00",
      ckBuylistCashEtched: "8.00",
    });

    // 4. Mana Pool Single winner (manapoolLowFoil $32.00 vs tcgMarketFoil $24.00, LP condition)
    const mpSingleCard = makeCatalogCard({
      scryfallId: "10000000-0000-4000-8000-000000000004",
      name: "Force of Negation",
      setCode: "2x2",
      setName: "Double Masters 2022",
      collectorNumber: "50",
      rarity: "mythic",
      tcgplayerId: 276001,
      tcgMarketFoil: "24.00",
      tcgLowFoil: "24.00",
      manapoolLowFoil: "32.00",
      ckBuylistCashFoil: "10.00",
    });

    // 5. P2P 85% Claim Sale winner ($28.00 retail -> P2P $23.80 ships $0.90 PWE = $21.57 net vs MP $20.24 / TCG $18.74!)
    const p2pSingleCard = makeCatalogCard({
      scryfallId: "10000000-0000-4000-8000-000000000005",
      name: "Boseiju, Who Endures",
      setCode: "neo",
      setName: "Kamigawa: Neon Dynasty",
      collectorNumber: "266",
      rarity: "rare",
      tcgMarketNm: "28.00",
      tcgLowNm: "28.00",
      manapoolLowNm: "28.00",
      ckBuylistCashNm: "15.00",
    });

    const routed = routeCollectionLot({
      purchaseCostUsd: "120.00",
      profile: { enableCreditArbitrage: true },
      items: [
        { card: ckCashCard, finish: "foil", condition: "NM", quantity: 10 },
        { card: ckCreditCard, finish: "etched", condition: "NM", quantity: 10 },
        { card: tcgSingleCard, finish: "etched", condition: "LP", quantity: 1 },
        { card: mpSingleCard, finish: "foil", condition: "LP", quantity: 2, language: "ja" },
        { card: p2pSingleCard, finish: "normal", condition: "NM", quantity: 1 },
      ],
    });

    const allExports = generateAllLotExports(routed.items, {
      strictConduitValidation: true,
    });

    // Card Kingdom Cash & Credit CSVs (Foil=true for both foil & etched)
    const ckCashParsed = parseCsvMatrix(allExports.cardKingdomCash.csv);
    expect(ckCashParsed.headers).toEqual([...CARD_KINGDOM_BUYLIST_SPEC_HEADERS]);
    expect(ckCashParsed.records[0]!.values).toEqual([
      "Counterspell",
      "Modern Horizons 2",
      "true",
      "10",
    ]);

    const ckTitleExport = exportCardKingdomBuylistCsv(routed.items, {
      mode: "credit",
      headerStyle: "ck_title",
    });
    const ckCreditParsed = parseCsvMatrix(ckTitleExport.csv);
    expect(ckCreditParsed.headers).toEqual([
      ...CARD_KINGDOM_BUYLIST_TITLE_HEADERS,
    ]);
    expect(ckCreditParsed.records[0]!.values).toEqual([
      "Swords to Plowshares",
      "Double Masters 2022",
      "true",
      "10",
    ]);

    // TCGplayer Staged Inventory CSV (18 columns, tcgplayer_etched_id = 218002, "Lightly Played Foil")
    const tcgExport = exportTcgplayerStagedCsv(routed.items);
    const tcgParsed = parseCsvMatrix(tcgExport.csv);
    expect(tcgParsed.headers).toEqual([...TCGPLAYER_STAGED_HEADERS]);
    expect(tcgParsed.records).toHaveLength(1);
    const tcgRow = tcgParsed.records[0]!.values;
    expect(tcgRow[0]).toBe("218002");
    expect(tcgRow[1]).toBe("Magic");
    expect(tcgRow[3]).toBe("Jace, the Mind Sculptor");
    expect(tcgRow[7]).toBe("Lightly Played Foil");
    expect(tcgRow[13]).toBe("1"); // Add to Quantity
    expect(tcgRow[14]).toBe("30.80"); // 35.00 * 0.88

    // Mana Pool Staged Singles CSV (10 columns, Japanese language preserved)
    const mpExport = exportManapoolStagedCsv(routed.items);
    const mpParsed = parseCsvMatrix(mpExport.csv);
    expect(mpParsed.headers).toEqual([...MANAPOOL_STAGED_HEADERS]);
    expect(mpParsed.records).toHaveLength(1);
    expect(mpParsed.records[0]!.values).toEqual([
      "10000000-0000-4000-8000-000000000004",
      "276001",
      "2X2",
      "50",
      "Force of Negation",
      "foil",
      "LP",
      "ja",
      "2",
      "28.16", // 32.00 * 0.88
    ]);

    // Discord / Facebook 85% Claim Sale Markdown
    const p2pExport = exportP2pClaimMarkdown(routed.items);
    expect(p2pExport.totalCards).toBe(1);
    expect(p2pExport.totalRetailReferenceUsd).toBe("28.00");
    expect(p2pExport.totalClaimValueUsd).toBe("23.80");
    expect(p2pExport.markdown).toContain("### Mid-Tier Staples ($15.00 - $49.99)");
    expect(p2pExport.markdown).toContain(
      "1x Boseiju, Who Endures (NEO #266 - NM/Normal) — TCG Low: $28.00 -> Claim: $23.80",
    );
  });
});
