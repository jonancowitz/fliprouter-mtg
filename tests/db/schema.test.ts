import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/index";
import * as schema from "../../src/db/schema";
import {
  cardCatalog,
  collectionLots,
  fromCatalogFinish,
  lotItems,
  RECOMMENDED_CHANNELS,
  skuPriceCache,
  toCatalogFinish,
  userRoutingProfiles,
} from "../../src/db/schema";

function loadPythonSqlConstant(constantName: string): string {
  const pySource = fs.readFileSync(
    path.resolve(__dirname, "../../scripts/sync_catalog.py"),
    "utf8",
  );
  const pattern = new RegExp(
    `^${constantName}\\s*=\\s*"""([\\s\\S]*?)"""`,
    "m",
  );
  const match = pattern.exec(pySource);
  if (!match?.[1]) {
    throw new Error(`Missing SQL constant ${constantName} in sync_catalog.py`);
  }
  return match[1].trim();
}

function bindNamedSql(
  namedSql: string,
  params: Record<string, unknown>,
): { query: string; values: unknown[] } {
  const values: unknown[] = [];

  const query = namedSql.replace(/%\(([a-zA-Z0-9_]+)\)s/g, (_full, key: string) => {
    if (!(key in params)) {
      throw new Error(`Missing SQL bind parameter: ${key}`);
    }
    values.push(params[key]);
    return `$${values.length}`;
  });

  return { query, values };
}

describe("FlipRouter MTG PostgreSQL Drizzle Schema", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: path.resolve(__dirname, "../../drizzle"),
    });
  });

  afterAll(async () => {
    await client.close();
  });

  it("creates all five required tables with NUMERIC(10, 2) currency columns", async () => {
    const tablesResult = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    const tableNames = tablesResult.rows.map((r) => r.table_name);
    expect(tableNames).toEqual([
      "card_catalog",
      "collection_lots",
      "lot_items",
      "sku_price_cache",
      "user_routing_profiles",
    ]);

    const numericCols = await client.query<{
      table_name: string;
      column_name: string;
      numeric_precision: number;
      numeric_scale: number;
    }>(`
      SELECT table_name, column_name, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'numeric'
      ORDER BY table_name, column_name;
    `);

    expect(numericCols.rows.length).toBeGreaterThanOrEqual(33);
    for (const col of numericCols.rows) {
      expect(col.numeric_precision).toBe(10);
      expect(col.numeric_scale).toBe(2);
    }
  });

  it("maintains required indexes on card_catalog and sku_price_cache", async () => {
    const indexesResult = await client.query<{
      tablename: string;
      indexname: string;
      indexdef: string;
    }>(`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public';
    `);

    const byName = new Map(
      indexesResult.rows.map((row) => [row.indexname, row.indexdef]),
    );

    expect(byName.has("idx_card_lookup")).toBe(true);
    expect(byName.get("idx_card_lookup")?.toLowerCase()).toContain(
      "lower((set_code)::text)",
    );
    expect(byName.get("idx_card_lookup")?.toLowerCase()).toContain(
      "collector_number",
    );
    expect(byName.has("idx_tcgplayer_id")).toBe(true);
    expect(byName.has("idx_tcgplayer_etched_id")).toBe(true);
    expect(byName.has("sku_price_cache_pkey")).toBe(true);
    expect(byName.has("idx_sku_price_cache_expires_at")).toBe(true);
  });

  it("supports card_catalog etched columns, upsert on scryfall_id, and case-insensitive set lookup", async () => {
    const scryfallId = "7673784e-db4b-43a1-8d55-1bb9fc1e284f";
    const oracleId = "4457ed35-7c10-48c8-9776-456485fdf070";

    await db.insert(cardCatalog).values({
      scryfallId,
      oracleId,
      tcgplayerId: 697344,
      tcgplayerEtchedId: 697345,
      name: "Lightning Bolt",
      setCode: "2x2",
      setName: "Double Masters 2022",
      collectorNumber: "117",
      rarity: "uncommon",
      finishes: ["nonfoil", "foil", "etched"],
      tcgMarketNm: "2.45",
      tcgMarketEtched: "6.40",
      tcgLowEtched: "5.95",
      manapoolLowEtched: "5.80",
      ckBuylistCashNm: "1.20",
      ckBuylistCreditNm: "1.56",
      ckBuylistCashEtched: "3.50",
      ckBuylistCreditEtched: "4.55",
    });

    await db
      .insert(cardCatalog)
      .values({
        scryfallId,
        oracleId,
        tcgplayerId: 697344,
        name: "Lightning Bolt",
        setCode: "2x2",
        setName: "Double Masters 2022",
        collectorNumber: "117",
        rarity: "uncommon",
        finishes: ["nonfoil", "foil", "etched"],
        tcgMarketNm: "2.75",
      })
      .onConflictDoUpdate({
        target: cardCatalog.scryfallId,
        set: {
          tcgMarketNm: "2.75",
          updatedAt: new Date(),
        },
      });

    const found = await db
      .select()
      .from(cardCatalog)
      .where(
        sql`LOWER(${cardCatalog.setCode}) = LOWER(${"2X2"}) AND ${cardCatalog.collectorNumber} = ${"117"}`,
      );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      tcgMarketNm: "2.75",
      tcgMarketEtched: "6.40",
      tcgLowEtched: "5.95",
      manapoolLowEtched: "5.80",
      ckBuylistCashEtched: "3.50",
      ckBuylistCreditEtched: "4.55",
    });
  });

  it("stores 24h TTL condition quotes in sku_price_cache keyed on (scryfall_id, finish, condition)", async () => {
    const scryfallId = "7673784e-db4b-43a1-8d55-1bb9fc1e284f";

    const [cached] = await db
      .insert(skuPriceCache)
      .values({
        scryfallId,
        finish: "foil",
        condition: "LP",
        retailLowUsd: "4.10",
        retailMarketUsd: "4.35",
        buylistCashUsd: "2.25",
        buylistCreditUsd: "2.93",
        source: "tcgapis",
      })
      .returning();

    expect(cached).toMatchObject({
      scryfallId,
      finish: "foil",
      condition: "LP",
      retailLowUsd: "4.10",
      buylistCashUsd: "2.25",
      source: "tcgapis",
    });
    expect(cached!.expiresAt.getTime()).toBeGreaterThan(
      cached!.fetchedAt.getTime() + 23 * 60 * 60 * 1000,
    );

    const freshHits = await db
      .select()
      .from(skuPriceCache)
      .where(
        and(
          eq(skuPriceCache.scryfallId, scryfallId),
          eq(skuPriceCache.finish, "foil"),
          eq(skuPriceCache.condition, "LP"),
          gt(skuPriceCache.expiresAt, sql`NOW()`),
        ),
      );
    expect(freshHits).toHaveLength(1);
  });

  it("applies box shipping, API quota, Schedule C COGS, and quarantine defaults with cascading deletes", async () => {
    const userId = "11111111-2222-3333-4444-555555555555";
    const scryfallId = "7673784e-db4b-43a1-8d55-1bb9fc1e284f";

    const [profile] = await db
      .insert(userRoutingProfiles)
      .values({ userId })
      .returning();

    expect(profile).toMatchObject({
      userId,
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
    });
    expect(profile?.skuApiQuotaResetAt).toBeInstanceOf(Date);

    const [lot] = await db
      .insert(collectionLots)
      .values({
        userId,
        lotName: "Saturday Garage Binder Buy",
        purchaseCostUsd: "350.00",
        totalCards: 2,
        actualRealizedPayoutUsd: "485.50",
      })
      .returning();

    expect(lot).toMatchObject({
      purchaseCostUsd: "350.00",
      status: "draft",
      actualRealizedPayoutUsd: "485.50",
    });

    const [insertedItem] = await db
      .insert(lotItems)
      .values({
        lotId: lot!.lotId,
        scryfallId,
        quantity: 2,
        finish: "normal",
        condition: "NM",
        allocatedCostBasisUsd: "1.50",
        netTcgplayerSingle: "0.19",
        netCkCash: "1.20",
        assignedBucket: "PILE_1_BUYLIST",
        recommendedChannel: "ck_cash",
        optimalUnitNetUsd: "1.20",
      })
      .returning();

    expect(insertedItem).toMatchObject({
      language: "en",
      isAltered: false,
      isMisprint: false,
      allocatedCostBasisUsd: "1.50",
    });

    await db
      .delete(collectionLots)
      .where(eq(collectionLots.lotId, lot!.lotId));

    const itemsAfter = await db
      .select()
      .from(lotItems)
      .where(eq(lotItems.lotId, lot!.lotId));
    expect(itemsAfter).toHaveLength(0);
  });

  it("executes exact Python sync_catalog.py SQL constants across Night-1 and Night-2 refreshes", async () => {
    const upsertScryfallSql = loadPythonSqlConstant("UPSERT_SCRYFALL_SQL");
    const updateIdentifiersSql = loadPythonSqlConstant("UPDATE_IDENTIFIERS_SQL");
    const resetDailyVendorPricesSql = loadPythonSqlConstant(
      "RESET_DAILY_VENDOR_PRICES_SQL",
    );
    const updatePricesSql = loadPythonSqlConstant("UPDATE_PRICES_BY_MTGJSON_SQL");
    const supplementManapoolSql = loadPythonSqlConstant(
      "SUPPLEMENT_MANAPOOL_BY_SCRYFALL_SQL",
    );
    const refreshManapoolSql = loadPythonSqlConstant(
      "REFRESH_MANAPOOL_BY_SCRYFALL_SQL",
    );
    const pruneExpiredSkuCacheSql = loadPythonSqlConstant(
      "PRUNE_EXPIRED_SKU_CACHE_SQL",
    );

    const scryfallId = "0000579f-7b35-4ed3-b44c-db2a538066fe";
    const oracleId = "44623693-51d6-49ad-8cd7-140505caf02f";
    const mtgjsonUuid = "0003caab-9ff5-5d1a-bc06-976dd0457f19";

    // Stage 1: Scryfall ON CONFLICT (scryfall_id) DO UPDATE
    const stage1 = bindNamedSql(upsertScryfallSql, {
      scryfall_id: scryfallId,
      oracle_id: oracleId,
      tcgplayer_id: 14200,
      tcgplayer_etched_id: null,
      cardkingdom_id: null,
      cardkingdom_foil_id: null,
      name: "Fury Sliver",
      set_code: "tsp",
      set_name: "Time Spiral",
      collector_number: "157",
      rarity: "uncommon",
      finishes: ["nonfoil", "foil", "etched"],
      image_uri: "https://cards.scryfall.io/normal/fury_sliver.jpg",
      tcg_market_nm: "0.43",
      tcg_market_foil: "1.58",
      tcg_market_etched: "3.10",
    });
    await client.query(stage1.query, stage1.values);

    // Stage 2: MTGJSON AllIdentifiers mapping update
    const stage2 = bindNamedSql(updateIdentifiersSql, {
      scryfall_id: scryfallId,
      mtgjson_uuid: mtgjsonUuid,
      tcgplayer_id: null,
      tcgplayer_etched_id: null,
      cardkingdom_id: 121001,
      cardkingdom_foil_id: 121002,
    });
    await client.query(stage2.query, stage2.values);

    // Night 1 — Stage 3: MTGJSON AllPricesToday update including etched buylist
    await client.query(resetDailyVendorPricesSql);
    const night1Stage3 = bindNamedSql(updatePricesSql, {
      mtgjson_uuid: mtgjsonUuid,
      tcg_market_nm: "0.49",
      tcg_low_nm: null,
      tcg_market_foil: null,
      tcg_low_foil: null,
      tcg_market_etched: null,
      tcg_low_etched: null,
      manapool_low_nm: "0.38",
      manapool_low_foil: null,
      manapool_low_etched: null,
      ck_buylist_cash_nm: "0.25",
      ck_buylist_credit_nm: "0.33",
      ck_buylist_cash_foil: null,
      ck_buylist_credit_foil: null,
      ck_buylist_cash_etched: "1.50",
      ck_buylist_credit_etched: "1.95",
    });
    await client.query(night1Stage3.query, night1Stage3.values);

    // Night 1 — Stage 4: Mana Pool public singles supplement fills only missing columns
    const night1Stage4 = bindNamedSql(supplementManapoolSql, {
      scryfall_id: scryfallId,
      tcgplayer_id: 14200,
      manapool_low_nm: "0.99",
      manapool_low_foil: "1.42",
      manapool_low_etched: "2.75",
    });
    const night1SupplementRes = await client.query(
      night1Stage4.query,
      night1Stage4.values,
    );
    expect(night1SupplementRes.affectedRows).toBe(1);

    // Re-running Stage 4 when no NULL columns remain does zero redundant writes
    const noopSupplementRes = await client.query(
      night1Stage4.query,
      night1Stage4.values,
    );
    expect(noopSupplementRes.affectedRows).toBe(0);

    const [afterNight1] = await db
      .select()
      .from(cardCatalog)
      .where(eq(cardCatalog.scryfallId, scryfallId));

    expect(afterNight1).toMatchObject({
      scryfallId,
      mtgjsonUuid,
      cardkingdomId: 121001,
      cardkingdomFoilId: 121002,
      tcgMarketNm: "0.49",
      tcgMarketFoil: "1.58", // Preserved from Stage 1 Scryfall baseline
      manapoolLowNm: "0.38", // Preserved from MTGJSON rather than overwritten by fallback
      manapoolLowFoil: "1.42", // Supplemented from Mana Pool singles feed
      manapoolLowEtched: "2.75", // Supplemented from Mana Pool singles feed
      ckBuylistCashNm: "0.25",
      ckBuylistCreditNm: "0.33",
      ckBuylistCashEtched: "1.50",
      ckBuylistCreditEtched: "1.95",
    });

    // Night 2: Card Kingdom drops its buylist offer, MTGJSON updates NM, and Mana Pool updates foil/etched
    await client.query(resetDailyVendorPricesSql);
    const night2Stage3 = bindNamedSql(updatePricesSql, {
      mtgjson_uuid: mtgjsonUuid,
      tcg_market_nm: "0.52",
      tcg_low_nm: null,
      tcg_market_foil: null,
      tcg_low_foil: null,
      tcg_market_etched: null,
      tcg_low_etched: null,
      manapool_low_nm: "0.41",
      manapool_low_foil: null,
      manapool_low_etched: null,
      ck_buylist_cash_nm: null,
      ck_buylist_credit_nm: null,
      ck_buylist_cash_foil: null,
      ck_buylist_credit_foil: null,
      ck_buylist_cash_etched: null,
      ck_buylist_credit_etched: null,
    });
    await client.query(night2Stage3.query, night2Stage3.values);

    const night2Stage4 = bindNamedSql(supplementManapoolSql, {
      scryfall_id: scryfallId,
      tcgplayer_id: 14200,
      manapool_low_nm: "0.95",
      manapool_low_foil: "1.19",
      manapool_low_etched: null,
    });
    const night2SupplementRes = await client.query(
      night2Stage4.query,
      night2Stage4.values,
    );
    expect(night2SupplementRes.affectedRows).toBe(1);

    // Non-etched card with NULL incoming etched price performs 0 writes on repeat check
    const night2RepeatRes = await client.query(
      night2Stage4.query,
      night2Stage4.values,
    );
    expect(night2RepeatRes.affectedRows).toBe(0);

    const [afterNight2] = await db
      .select()
      .from(cardCatalog)
      .where(eq(cardCatalog.scryfallId, scryfallId));

    expect(afterNight2).toMatchObject({
      tcgMarketNm: "0.52",
      manapoolLowNm: "0.41",
      manapoolLowFoil: "1.19", // Refreshed on Night 2 instead of frozen at Night 1's 1.42
      manapoolLowEtched: null, // Cleared when out of NM stock
      ckBuylistCashNm: null, // Dropped CK buylist offer cleared instead of lingering
      ckBuylistCreditNm: null,
      ckBuylistCashEtched: null,
      ckBuylistCreditEtched: null,
    });

    // Standalone `--skip-prices` Stage 4 (`REFRESH_MANAPOOL_BY_SCRYFALL_SQL`) overwrites Mana Pool directly
    const standaloneRefresh = bindNamedSql(refreshManapoolSql, {
      scryfall_id: scryfallId,
      tcgplayer_id: 14200,
      manapool_low_nm: "0.39",
      manapool_low_foil: "1.15",
      manapool_low_etched: "2.60",
    });
    await client.query(standaloneRefresh.query, standaloneRefresh.values);

    const [afterStandalone] = await db
      .select()
      .from(cardCatalog)
      .where(eq(cardCatalog.scryfallId, scryfallId));
    expect(afterStandalone).toMatchObject({
      manapoolLowNm: "0.39",
      manapoolLowFoil: "1.15",
      manapoolLowEtched: "2.60",
    });

    // Stage 5: Expired sku_price_cache pruning
    await db.insert(skuPriceCache).values({
      scryfallId,
      finish: "normal",
      condition: "LP",
      retailLowUsd: "0.35",
      source: "justtcg",
      expiresAt: new Date(Date.now() - 60_000),
    });
    await client.query(pruneExpiredSkuCacheSql);

    const remainingCache = await db
      .select()
      .from(skuPriceCache)
      .where(eq(skuPriceCache.scryfallId, scryfallId));
    expect(remainingCache).toHaveLength(0);
  });

  it("caches getDb() singleton in NODE_ENV=production and exposes Step 3 finish/channel helpers", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevDbUrl = process.env.DATABASE_URL;
    try {
      await closeDb();
      process.env.NODE_ENV = "production";
      process.env.DATABASE_URL =
        "postgresql://postgres:postgres@127.0.0.1:5432/fliprouter_test_lazy";

      const dbFirst = getDb();
      const dbSecond = getDb();
      expect(dbSecond).toBe(dbFirst);
    } finally {
      await closeDb();
      if (prevNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prevNodeEnv;
      }
      if (prevDbUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = prevDbUrl;
      }
    }

    expect(toCatalogFinish("normal")).toBe("nonfoil");
    expect(toCatalogFinish("foil")).toBe("foil");
    expect(toCatalogFinish("etched")).toBe("etched");
    expect(fromCatalogFinish("nonfoil")).toBe("normal");
    expect(fromCatalogFinish("Foil Etched")).toBe("etched");
    expect(fromCatalogFinish("Foil")).toBe("foil");
    expect(RECOMMENDED_CHANNELS).toContain("conduit_standard");
    expect(RECOMMENDED_CHANNELS).toContain("tcgplayer_single");
  });
});
