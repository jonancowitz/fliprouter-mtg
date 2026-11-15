import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  cardCatalog,
  collectionLots,
  lotItems,
  skuPriceCache,
} from "@/db/schema";
import {
  CsvParseError,
  detectScannerFormat,
  normalizeCondition,
  normalizeFinish,
  normalizeLanguage,
  parseCsvMatrix,
  parseScannerCsv,
} from "@/lib/csv/parser";
import {
  fetchFreshSkuPriceCacheMap,
  resolvedRowsToRoutingInputs,
  resolveParsedCsvRows,
} from "@/lib/csv/resolver";
import { routeCollectionLot } from "@/lib/routing/engine";

describe("RFC-4180 CSV Matrix & Field Normalizers", () => {
  it("handles UTF-8 BOM, quoted commas, escaped quotes, CRLF, embedded newlines, and trailing blank lines", () => {
    const csv =
      '\uFEFFName,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency\r\n' +
      '"Jace, the Mind Sculptor",2xm,"Double Masters\r\nVIP",332,foil,mythic,2,101,7673784e-db4b-43a1-8d55-1bb9fc1e284f,45.00,false,false,lightly_played,Japanese,USD\r\n' +
      '"""Ach! Hans, Run!""",unh,Unhinged,116,normal,rare,1,102,,2.50,true,false,near_mint,"Chinese (Simplified)",USD\r\n\r\n   \r\n';

    const matrix = parseCsvMatrix(csv);
    expect(matrix.headers[0]).toBe("Name");
    expect(matrix.records).toHaveLength(2);

    const parsed = parseScannerCsv(csv);
    expect(parsed.format).toBe("manabox");
    expect(parsed.rows).toHaveLength(2);

    expect(parsed.rows[0]).toMatchObject({
      cardName: "Jace, the Mind Sculptor",
      setCode: "2xm",
      collectorNumber: "332",
      finish: "foil",
      condition: "LP",
      language: "ja",
      quantity: 2,
      scryfallId: "7673784e-db4b-43a1-8d55-1bb9fc1e284f",
    });

    expect(parsed.rows[1]).toMatchObject({
      cardName: '"Ach! Hans, Run!"',
      setCode: "unh",
      collectorNumber: "116",
      finish: "normal",
      condition: "NM",
      language: "zhs",
      isMisprint: true,
      isAltered: false,
      quantity: 1,
    });
  });

  it("throws CsvParseError on unterminated quotes or unknown headers", () => {
    expect(() => parseCsvMatrix('Name,Quantity\n"Unclosed,1')).toThrow(
      CsvParseError,
    );
    expect(() => detectScannerFormat(["Foo", "Bar", "Baz"])).toThrow(
      CsvParseError,
    );
  });

  it("maps full scanner language strings case-insensitively to <= 16 char Scryfall ISO codes", () => {
    expect(normalizeLanguage("English")).toBe("en");
    expect(normalizeLanguage("Chinese (Simplified)")).toBe("zhs");
    expect(normalizeLanguage("Simplified Chinese")).toBe("zhs");
    expect(normalizeLanguage("Traditional Chinese")).toBe("zht");
    expect(normalizeLanguage("Chinese (Traditional)")).toBe("zht");
    expect(normalizeLanguage("Portuguese (Brazil)")).toBe("pt");
    expect(normalizeLanguage("Japanese")).toBe("ja");
    expect(normalizeLanguage("German")).toBe("de");
    expect(normalizeLanguage("Phyrexian")).toBe("ph");
    expect(normalizeLanguage("Korean")).toBe("ko");
    expect(normalizeLanguage("Russian")).toBe("ru");
    const unknownLong = normalizeLanguage(
      "Some Extremely Verbose Custom Regional Dialect Name",
    );
    expect(unknownLong.length).toBeLessThanOrEqual(16);
  });

  it("normalizes finish and condition variants across all 4 scanners", () => {
    expect(normalizeFinish("Foil Etched")).toBe("etched");
    expect(normalizeFinish("Normal", "Lightly Played Foil")).toBe("foil");
    expect(normalizeFinish("Non-Foil")).toBe("normal");
    expect(normalizeCondition("Lightly Played Foil")).toBe("LP");
    expect(normalizeCondition("Excellent")).toBe("LP");
    expect(normalizeCondition("ModeratelyPlayed")).toBe("MP");
    expect(normalizeCondition("Poor")).toBe("HP");
    expect(normalizeCondition("Damaged")).toBe("DMG");
  });
});

describe("All 4 Scanner CSV Parsers & Batched PGlite Catalog Resolution", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const boltId = "7673784e-db4b-43a1-8d55-1bb9fc1e284f";
  const ragavanId = "11111111-2222-4333-8444-555555555555";
  const solitudeId = "22222222-3333-4444-8555-666666666666";

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: path.resolve(__dirname, "../../drizzle"),
    });

    await db.insert(cardCatalog).values([
      {
        scryfallId: boltId,
        oracleId: "4457ed35-7c10-48c8-9776-456485fdf070",
        tcgplayerId: 697344,
        tcgplayerEtchedId: 697345,
        name: "Lightning Bolt",
        setCode: "2x2",
        setName: "Double Masters 2022",
        collectorNumber: "117",
        rarity: "uncommon",
        finishes: ["nonfoil", "foil", "etched"],
        tcgMarketNm: "2.50",
        tcgMarketEtched: "6.50",
        ckBuylistCashNm: "1.25",
        ckBuylistCashEtched: "3.50",
      },
      {
        scryfallId: ragavanId,
        oracleId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        tcgplayerId: 240201,
        tcgplayerEtchedId: 240202,
        name: "Ragavan, Nimble Pilferer",
        setCode: "mh2",
        setName: "Modern Horizons 2",
        collectorNumber: "138",
        rarity: "mythic",
        finishes: ["nonfoil", "foil"],
        tcgMarketNm: "38.00",
        tcgMarketFoil: "52.00",
        ckBuylistCashNm: "24.00",
        ckBuylistCashFoil: "32.00",
      },
      {
        scryfallId: solitudeId,
        oracleId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        tcgplayerId: 240300,
        tcgplayerEtchedId: null,
        name: "Solitude",
        setCode: "mh2",
        setName: "Modern Horizons 2",
        collectorNumber: "32",
        rarity: "mythic",
        finishes: ["nonfoil", "foil"],
        tcgMarketNm: "14.00",
        ckBuylistCashNm: "8.00",
      },
    ]);

    await db.insert(skuPriceCache).values({
      scryfallId: ragavanId,
      finish: "foil",
      condition: "LP",
      retailLowUsd: "43.00",
      retailMarketUsd: "45.00",
      buylistCashUsd: "26.00",
      buylistCreditUsd: "33.80",
      source: "tcgapis",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
  });

  afterAll(async () => {
    await client.close();
  });

  it("parses Delver Lens CSV and resolves by Scryfall ID", async () => {
    const delverCsv = [
      "Name,Edition,Edition code,Collector's number,Price,Foil,Quantity,Scryfall ID,Condition,Language",
      `"Ragavan, Nimble Pilferer",Modern Horizons 2,MH2,138,$45.00,Foil,1,${ragavanId},LP,English`,
    ].join("\n");

    const parsed = parseScannerCsv(delverCsv);
    expect(parsed.format).toBe("delver_lens");
    const resolution = await resolveParsedCsvRows(parsed.rows, db);

    expect(resolution.unresolved).toHaveLength(0);
    expect(resolution.resolved[0]).toMatchObject({
      matchedBy: "scryfall_id",
      effectiveFinish: "foil",
      finishListedInCatalog: true,
    });

    const skuCacheMap = await fetchFreshSkuPriceCacheMap(
      db,
      resolution.resolved,
      new Date("2026-11-15T12:00:00Z"),
    );
    const routingInputs = resolvedRowsToRoutingInputs(
      resolution.resolved,
      skuCacheMap,
    );
    expect(routingInputs[0]!.skuPriceCache?.retailMarketUsd).toBe("45.00");
  });

  it("parses TCGplayer App CSV, matches tcgplayer_etched_id for Etched printing, and falls back to (LOWER(set_code), collector_number)", async () => {
    const tcgCsv = [
      "Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU",
      "2,Lightning Bolt (Foil Etched),Lightning Bolt,Double Masters 2022,117,2X2,Foil Etched,Near Mint,English,Uncommon,697345,5001",
      "1,Solitude,Solitude,Modern Horizons 2,32,MH2,Normal,Lightly Played,Portuguese (Brazil),Mythic,9999999,5002",
      "0,Zero Qty Ignored,Zero Qty Ignored,Modern Horizons 2,32,MH2,Normal,Near Mint,English,Mythic,240300,5003",
    ].join("\n");

    const parsed = parseScannerCsv(tcgCsv);
    expect(parsed.format).toBe("tcgplayer_app");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.skippedRows).toHaveLength(1);
    expect(parsed.skippedRows[0]!.reason).toBe("zero_quantity");

    const resolution = await resolveParsedCsvRows(parsed.rows, db);
    expect(resolution.unresolved).toHaveLength(0);

    // Row 1 matched via tcgplayer_etched_id
    expect(resolution.resolved[0]).toMatchObject({
      matchedBy: "tcgplayer_etched_id",
      effectiveFinish: "etched",
    });
    expect(resolution.resolved[0]!.card.scryfallId).toBe(boltId);

    // Row 2 had unknown Product ID 9999999 -> fell back to (LOWER('MH2'), '32')!
    expect(resolution.resolved[1]).toMatchObject({
      matchedBy: "set_collector",
      effectiveFinish: "normal",
    });
    expect(resolution.resolved[1]!.parsedRow.language).toBe("pt");
    expect(resolution.resolved[1]!.card.scryfallId).toBe(solitudeId);
  });

  it("parses Dragon Shield CSV, cleans promo 'p' set prefixes & zero-padded/slashed collector numbers, and reports unresolved rows", async () => {
    const dragonShieldCsv = [
      "Folder Name,Quantity,Trade Quantity,Card Name,Set Code,Set Name,Card Number,Condition,Printing,Language,Price Bought,Date Bought,LOW,MID,MARKET",
      'Binder A,3,1,"Ragavan, Nimble Pilferer",PMH2,Modern Horizons 2 Promos,138/303,NearMint,Foil,Traditional Chinese,20.00,2026-10-01,40.00,48.00,52.00',
      "Binder A,1,0,Solitude,MH2,Modern Horizons 2,032,ModeratelyPlayed,Normal,German,5.00,2026-10-01,10.00,12.00,14.00",
      "Binder A,1,0,Imaginary Card,ZZZ,Fake Set,999,Damaged,Normal,Phyrexian,0.10,2026-10-01,0.10,0.10,0.10",
    ].join("\n");

    const parsed = parseScannerCsv(dragonShieldCsv);
    expect(parsed.format).toBe("dragon_shield");
    expect(parsed.rows).toHaveLength(3);

    const resolution = await resolveParsedCsvRows(parsed.rows, db);
    expect(resolution.resolved).toHaveLength(2);
    expect(resolution.unresolved).toHaveLength(1);

    // PMH2 + 138/303 normalized to mh2 #138
    expect(resolution.resolved[0]!.card.scryfallId).toBe(ragavanId);
    expect(resolution.resolved[0]!.matchedBy).toBe("set_collector_normalized");
    expect(resolution.resolved[0]!.parsedRow.language).toBe("zht");

    // MH2 + 032 normalized to mh2 #32
    expect(resolution.resolved[1]!.card.scryfallId).toBe(solitudeId);
    expect(resolution.resolved[1]!.matchedBy).toBe("set_collector_normalized");
    expect(resolution.resolved[1]!.parsedRow.condition).toBe("MP");
    expect(resolution.resolved[1]!.parsedRow.language).toBe("de");

    // Unresolved diagnostic for ZZZ #999
    expect(resolution.unresolved[0]).toMatchObject({
      rowNumber: 4,
      reason: "catalog_not_found",
      attemptedStrategies: ["set_collector:zzz#999"],
    });
    expect(resolution.unresolved[0]!.parsedRow.language).toBe("ph");
  });

  it("persists routed collection_lots and lot_items rows end-to-end in PGlite with cent-exact COGS", async () => {
    const manaboxCsv = [
      "Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency",
      `"Ragavan, Nimble Pilferer",mh2,Modern Horizons 2,138,foil,mythic,1,1,${ragavanId},25.00,false,false,lightly_played,English,USD`,
      `Solitude,mh2,Modern Horizons 2,32,normal,mythic,2,2,${solitudeId},8.00,false,false,near_mint,"Chinese (Simplified)",USD`,
    ].join("\n");

    const parsed = parseScannerCsv(manaboxCsv);
    const resolution = await resolveParsedCsvRows(parsed.rows, db);
    const skuCacheMap = await fetchFreshSkuPriceCacheMap(
      db,
      resolution.resolved,
      new Date("2026-11-15T12:00:00Z"),
    );

    const routed = routeCollectionLot({
      purchaseCostUsd: "50.00",
      items: resolvedRowsToRoutingInputs(resolution.resolved, skuCacheMap),
    });

    const [insertedLot] = await db
      .insert(collectionLots)
      .values({
        userId: "99999999-8888-4777-8666-555555555555",
        lotName: "Weekend Binder Pickup",
        purchaseCostUsd: routed.summary.purchaseCostUsd,
        totalCards: routed.summary.totalCards,
        status: routed.summary.status,
        estimatedGrossValueUsd: routed.summary.estimatedGrossValueUsd,
        estimatedNetPayoutUsd: routed.summary.estimatedNetPayoutUsd,
      })
      .returning();

    const persistedItems = await db
      .insert(lotItems)
      .values(routed.toNewLotItems(insertedLot!.lotId))
      .returning();

    expect(persistedItems).toHaveLength(2);
    expect(persistedItems[1]!.language).toBe("zhs");
    expect(routed.summary.allocatedCostBasisSumUsd).toBe("50.00");
  });
});
