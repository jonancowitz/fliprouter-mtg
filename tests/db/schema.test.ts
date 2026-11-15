import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import {
  cardCatalog,
  collectionLots,
  lotItems,
  userRoutingProfiles,
} from "../../src/db/schema";

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

  it("creates all four required tables with NUMERIC(10, 2) currency columns", async () => {
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

    expect(numericCols.rows.length).toBeGreaterThanOrEqual(22);
    for (const col of numericCols.rows) {
      expect(col.numeric_precision).toBe(10);
      expect(col.numeric_scale).toBe(2);
    }
  });

  it("maintains required indexes idx_card_lookup (LOWER(set_code), collector_number) and idx_tcgplayer_id", async () => {
    const indexesResult = await client.query<{
      indexname: string;
      indexdef: string;
    }>(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'card_catalog';
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
  });

  it("supports card_catalog upsert on scryfall_id and case-insensitive set lookup", async () => {
    const scryfallId = "7673784e-db4b-43a1-8d55-1bb9fc1e284f";
    const oracleId = "4457ed35-7c10-48c8-9776-456485fdf070";

    await db.insert(cardCatalog).values({
      scryfallId,
      oracleId,
      tcgplayerId: 697344,
      name: "Lightning Bolt",
      setCode: "2x2",
      setName: "Double Masters 2022",
      collectorNumber: "117",
      rarity: "uncommon",
      finishes: ["nonfoil", "foil"],
      tcgMarketNm: "2.45",
      ckBuylistCashNm: "1.20",
      ckBuylistCreditNm: "1.56",
    });

    // Upsert updated price via ON CONFLICT (scryfall_id) DO UPDATE
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
        finishes: ["nonfoil", "foil"],
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
    expect(found[0]?.tcgMarketNm).toBe("2.75");
    expect(found[0]?.ckBuylistCashNm).toBe("1.20");
    expect(found[0]?.finishes).toEqual(["nonfoil", "foil"]);
  });

  it("applies exact spec defaults on user_routing_profiles and cascades lot_items deletion", async () => {
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
      minSingleNetGainOverBuylistUsd: "1.25",
      enableCreditArbitrage: false,
      conduitTierPreference: "curated",
    });

    const [lot] = await db
      .insert(collectionLots)
      .values({
        userId,
        lotName: "Saturday Garage Binder Buy",
        purchaseCostUsd: "350.00",
        totalCards: 2,
      })
      .returning();

    expect(lot?.lotId).toBeDefined();
    expect(lot?.purchaseCostUsd).toBe("350.00");

    await db.insert(lotItems).values({
      lotId: lot!.lotId,
      scryfallId,
      quantity: 2,
      finish: "normal",
      condition: "NM",
      netTcgplayerSingle: "0.19",
      netCkCash: "1.20",
      assignedBucket: "PILE_1_BUYLIST",
      recommendedChannel: "ck_cash",
      optimalUnitNetUsd: "1.20",
    });

    const itemsBefore = await db
      .select()
      .from(lotItems)
      .where(eq(lotItems.lotId, lot!.lotId));
    expect(itemsBefore).toHaveLength(1);

    await db
      .delete(collectionLots)
      .where(eq(collectionLots.lotId, lot!.lotId));

    const itemsAfter = await db
      .select()
      .from(lotItems)
      .where(eq(lotItems.lotId, lot!.lotId));
    expect(itemsAfter).toHaveLength(0);
  });

  it("executes Python sync_catalog.py SQL upsert and update statements against PostgreSQL", async () => {
    const scryfallId = "0000579f-7b35-4ed3-b44c-db2a538066fe";
    const oracleId = "44623693-51d6-49ad-8cd7-140505caf02f";
    const mtgjsonUuid = "0003caab-9ff5-5d1a-bc06-976dd0457f19";

    // Stage 1: Scryfall ON CONFLICT (scryfall_id) DO UPDATE
    await client.query(
      `
      INSERT INTO card_catalog (
        scryfall_id, oracle_id, tcgplayer_id, tcgplayer_etched_id,
        cardkingdom_id, cardkingdom_foil_id, name, set_code, set_name,
        collector_number, rarity, finishes, image_uri,
        tcg_market_nm, tcg_market_foil, tcg_market_etched, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW()
      )
      ON CONFLICT (scryfall_id) DO UPDATE SET
        oracle_id = EXCLUDED.oracle_id,
        tcgplayer_id = COALESCE(EXCLUDED.tcgplayer_id, card_catalog.tcgplayer_id),
        name = EXCLUDED.name,
        set_code = EXCLUDED.set_code,
        set_name = EXCLUDED.set_name,
        collector_number = EXCLUDED.collector_number,
        rarity = EXCLUDED.rarity,
        finishes = EXCLUDED.finishes,
        tcg_market_nm = COALESCE(EXCLUDED.tcg_market_nm, card_catalog.tcg_market_nm),
        updated_at = NOW();
      `,
      [
        scryfallId,
        oracleId,
        14200,
        null,
        null,
        null,
        "Fury Sliver",
        "tsp",
        "Time Spiral",
        "157",
        "uncommon",
        ["nonfoil", "foil"],
        "https://cards.scryfall.io/normal/fury_sliver.jpg",
        "0.43",
        "1.58",
        null,
      ],
    );

    // Stage 2: MTGJSON AllIdentifiers mapping update
    await client.query(
      `
      UPDATE card_catalog
      SET
        mtgjson_uuid = CASE
          WHEN EXISTS (
            SELECT 1
            FROM card_catalog existing
            WHERE existing.mtgjson_uuid = $1::uuid
              AND existing.scryfall_id <> $2::uuid
          ) THEN card_catalog.mtgjson_uuid
          ELSE $1::uuid
        END,
        cardkingdom_id = COALESCE($3, cardkingdom_id),
        cardkingdom_foil_id = COALESCE($4, cardkingdom_foil_id),
        updated_at = NOW()
      WHERE scryfall_id = $2::uuid;
      `,
      [mtgjsonUuid, scryfallId, 121001, 121002],
    );

    // Stage 3: MTGJSON AllPricesToday update by mtgjson_uuid
    await client.query(
      `
      UPDATE card_catalog
      SET
        tcg_market_nm = COALESCE($1, tcg_market_nm),
        manapool_low_nm = COALESCE($2, manapool_low_nm),
        ck_buylist_cash_nm = COALESCE($3, ck_buylist_cash_nm),
        ck_buylist_credit_nm = COALESCE($4, ck_buylist_credit_nm),
        updated_at = NOW()
      WHERE mtgjson_uuid = $5::uuid;
      `,
      ["0.49", "0.38", "0.25", "0.33", mtgjsonUuid],
    );

    const [synced] = await db
      .select()
      .from(cardCatalog)
      .where(eq(cardCatalog.scryfallId, scryfallId));

    expect(synced).toMatchObject({
      scryfallId,
      mtgjsonUuid,
      cardkingdomId: 121001,
      cardkingdomFoilId: 121002,
      tcgMarketNm: "0.49",
      manapoolLowNm: "0.38",
      ckBuylistCashNm: "0.25",
      ckBuylistCreditNm: "0.33",
    });
  });
});
