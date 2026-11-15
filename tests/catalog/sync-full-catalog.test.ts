import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GET as getSyncRoute,
  POST as postSyncRoute,
} from "@/app/api/catalog/sync/route";
import { createDetachedNewCollectionLotState } from "@/components/triage/triage-workspace";
import {
  cardCatalog,
  closeDb,
  collectionLots,
  getReadyDb,
  lotItems,
  skuPriceCache,
} from "@/db";
import {
  computeCkCreditUsd,
  parseCentsToUsdString,
  parseJsonUsdToString,
  resetCatalogSyncTrackerForTests,
  startCatalogSyncJob,
  syncFullCatalog,
} from "@/lib/catalog";
import { createPersistedLot } from "@/lib/triage";

const IDENTIFIERS_BZ2_B64 =
  "QlpoOTFBWSZTWSov8w4AAWrfgFSAUAd/8Ac4QA4/598qMAGY2ybQlKGQxR6TBNGmQAABkGJJHtU9IaANBoAABoCRKCNJ+lNPJkEyYhoGTRp5TMsdHBVq8FIG0MaBgpuOS2y/ryI02oOU7R0cAzBSNj/VXKo/KyMWm0mxMZ7qEQrrcmurUbRP5CETLhuUblUTzLmGkZ437M64sXFZbMxDjLpFFgx2JiUEC6B2mJgXC0CVV2UhPfE6hAug14kdkGTTMW5HoPmIZ4Xw4SUQA0jGjRqx8rgeqiIsH0PVeFJnkTJC89/bs28BwUVhQ+AZpw33KKltNRoKBUK0gkrsVuVmNHWFqDnoJKkeeopNOtd6M5IERDQnRJz0ga7rQ2NMUMA7jZXK2VlJqqxetNKeR6X3ubabeJUMS4UNRTAuipnFQVkaUotLLGI9PwH1AW0EZYgxiXAUwaloTAKRmyiukCzRFyjEOiAqwJgsXcsimZExSTzmE2y5SWJLvKVlvUEl8GvyxHUxCQS/i7kinChIFRf5hwA=";

const PRICES_NIGHT1_BZ2_B64 =
  "QlpoOTFBWSZTWVvSoKwAAQ7bgGyAUAd/cAAAv+/fqjABE1EYaGQ0yaAYhppo0NGCRSCeo9TIAAAyAeoFVAp5FPU/Sg9RoNqAAbSSJmssNWNtAxAZ52MG0+F1Oppd0chyuH7oG/2/N7KWW2saaaYhsearToS20HERtICNhFz4atIxpJajWsjVuQUq1lJCGcTcgieTvUAqipFoiGERGFLjWUQQOvFKWBiMUIjjgBGm9vRJpHdB+vH3cGCxY1ScHyp9OTJyvYwLrnF0HFt0upQ2grG7N/UXLpWsmbKYqY5mVmDRHsIpmJPLFmrSCqKWydppnMS/NI8hXeQS4MvnSeP4u5IpwoSC3pUFYA==";

const PRICES_NIGHT2_BZ2_B64 =
  "QlpoOTFBWSZTWYZE3IEAAFtZgFSAUAd/UD6v3yogAIqGpkU8U9lExqG0g0wNQSgkGoaMTI9EyDBJVmswjCDBglSpm771zI11G8hIEGFZaJwQYGLyxylGSknJ5KI4pji6dupSRg9BEeEAS60UZr9M/Yo8PIU/NrGsn/EXfmy13CLylx9DgatjdqDbBsYK9wnbdm4wDhUNSZUz2/i7kinChIQyJuQI";

describe("Step 5 Pure Node/TS Streaming Catalog Sync, Singleton Job API, & Lot Detachment", () => {
  const prevDbUrl = process.env.DATABASE_URL;
  const prevPgliteDir = process.env.PGLITE_DATA_DIR;
  let tmpDir: string;

  beforeEach(async () => {
    await resetCatalogSyncTrackerForTests();
    await closeDb();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = "memory://";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fliprouter-sync-test-"));
  });

  afterEach(async () => {
    await resetCatalogSyncTrackerForTests();
    await closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevDbUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = prevDbUrl;
    }
    if (prevPgliteDir === undefined) {
      delete process.env.PGLITE_DATA_DIR;
    } else {
      process.env.PGLITE_DATA_DIR = prevPgliteDir;
    }
  });

  it("quantizes USD strings, JSON floats/scientific notation, integer cents, and CK 1.30x credit without float drift", () => {
    expect(parseJsonUsdToString("0.34")).toBe("0.34");
    expect(parseJsonUsdToString(18.54)).toBe("18.54");
    expect(parseJsonUsdToString("2.125")).toBe("2.13");
    expect(parseJsonUsdToString(5e-2)).toBe("0.05");
    expect(parseJsonUsdToString("99999999.99")).toBe("99999999.99");
    expect(parseJsonUsdToString("100000000.00")).toBeNull();
    expect(parseJsonUsdToString(-1)).toBeNull();
    expect(parseJsonUsdToString(true)).toBeNull();

    expect(parseCentsToUsdString(291)).toBe("2.91");
    expect(parseCentsToUsdString("0")).toBe("0.00");
    expect(parseCentsToUsdString(-50)).toBeNull();

    expect(computeCkCreditUsd("1.35")).toBe("1.76"); // 1.35 * 1.30 = 1.755 -> 1.76 half-up
    expect(computeCkCreditUsd("10.00", "14.25")).toBe("14.25");
    expect(computeCkCreditUsd("80000000.00")).toBeNull(); // exceeds NUMERIC(10,2)
  });

  it("streams Scryfall (.jsonl.gz & JSON array), .bz2 MTGJSON Identifiers/Prices across Night 1->2, and Mana Pool NM singles while preserving saved lots", async () => {
    const { db } = await getReadyDb({ autoSeed: false });

    const scryfallCards = [
      // 1. Paper Lightning Bolt (2x2 #117)
      {
        id: "f29ba16f-c8fb-42fe-aabf-87089cb214a7",
        oracle_id: "4457ed35-7c10-48c8-9776-456485fdf070",
        name: "Lightning Bolt",
        set: "2X2",
        set_name: "Double Masters 2022",
        collector_number: "117",
        rarity: "uncommon",
        games: ["paper", "mtgo"],
        finishes: ["nonfoil", "foil"],
        image_uris: { normal: "https://cards.scryfall.io/normal/bolt.jpg" },
        prices: { usd: "2.45", usd_foil: "4.80", usd_etched: null },
      },
      // 2. Etched-only Force of Negation (2x2 #429) with card_faces fallback
      {
        id: "0d840284-ce56-4e4f-822f-8b237a261d1e",
        name: "Force of Negation",
        set: "2x2",
        set_name: "Double Masters 2022",
        collector_number: "429",
        rarity: "rare",
        games: ["paper"],
        finishes: ["etched"],
        card_faces: [
          {
            oracle_id: "ac2173f9-f223-440a-9231-fd98762bdc6f",
            image_uris: { normal: "https://cards.scryfall.io/normal/fon.jpg" },
          },
        ],
        prices: { usd: null, usd_foil: null, usd_etched: "44.50" },
      },
      // 3. Arena-only digital card (must be filtered out)
      {
        id: "99999999-1111-4111-8111-000000000099",
        oracle_id: "88888888-1111-4111-8111-000000000088",
        name: "Digital Only Conjure",
        set: "ymid",
        set_name: "Alchemy Innistrad",
        collector_number: "1",
        rarity: "rare",
        games: ["arena"],
        finishes: ["nonfoil"],
        prices: { usd: null },
      },
    ];

    const scryfallJsonlGzPath = path.join(tmpDir, "default-cards.jsonl.gz");
    const jsonlText = scryfallCards.map((c) => JSON.stringify(c)).join("\n");
    fs.writeFileSync(scryfallJsonlGzPath, zlib.gzipSync(Buffer.from(jsonlText)));

    const identifiersBz2Path = path.join(tmpDir, "AllIdentifiers.json.bz2");
    fs.writeFileSync(
      identifiersBz2Path,
      Buffer.from(IDENTIFIERS_BZ2_B64, "base64"),
    );

    const pricesNight1Bz2Path = path.join(tmpDir, "AllPricesToday-n1.json.bz2");
    fs.writeFileSync(
      pricesNight1Bz2Path,
      Buffer.from(PRICES_NIGHT1_BZ2_B64, "base64"),
    );

    const pricesNight2Bz2Path = path.join(tmpDir, "AllPricesToday-n2.json.bz2");
    fs.writeFileSync(
      pricesNight2Bz2Path,
      Buffer.from(PRICES_NIGHT2_BZ2_B64, "base64"),
    );

    const manapoolNight1Path = path.join(tmpDir, "manapool-singles-n1.json");
    fs.writeFileSync(
      manapoolNight1Path,
      JSON.stringify({
        meta: { as_of: "2026-11-15T06:00:00Z" },
        data: [
          {
            scryfall_id: "f29ba16f-c8fb-42fe-aabf-87089cb214a7",
            tcgplayer_product_id: 276484,
            // non-NM floor price_cents=99 must be ignored; price_cents_nm=299 should NOT overwrite MTGJSON 2.19;
            // price_cents_nm_foil=435 supplements NULL manapool_low_foil; price_cents_nm_etched=0 ignored!
            price_cents: 99,
            price_cents_nm: 299,
            price_cents_nm_foil: 435,
            price_cents_nm_etched: 0,
          },
          {
            scryfall_ids: ["0d840284-ce56-4e4f-822f-8b237a261d1e"],
            price_cents_nm_etched: 4215,
          },
        ],
      }),
    );

    // Night 1 full 4-stage sync (batchSize=1 to exercise multi-batch loops)
    const night1Stats = await syncFullCatalog(db, {
      scryfallSource: scryfallJsonlGzPath,
      identifiersSource: identifiersBz2Path,
      pricesSource: pricesNight1Bz2Path,
      manapoolSource: manapoolNight1Path,
      ensureDemoSkuCache: false,
      batchSize: 1,
    });

    expect(night1Stats.scryfallSeen).toBe(3);
    expect(night1Stats.scryfallUpserted).toBe(2); // Arena-only filtered
    expect(night1Stats.identifiersMapped).toBe(2); // side='b' filtered
    expect(night1Stats.pricesUpdated).toBe(2);
    expect(night1Stats.manapoolSupplemented).toBe(2);
    expect(night1Stats.finalCatalogCount).toBe(2);

    const [boltN1] = await db
      .select()
      .from(cardCatalog)
      .where(
        eq(cardCatalog.scryfallId, "f29ba16f-c8fb-42fe-aabf-87089cb214a7"),
      );
    expect(boltN1).toMatchObject({
      mtgjsonUuid: "aaaaaaaa-1111-4111-8111-000000000001",
      tcgplayerId: 276484,
      cardkingdomId: 260101,
      cardkingdomFoilId: 260102,
      tcgMarketNm: "2.65",
      tcgLowNm: "2.25",
      tcgMarketFoil: "5.10",
      manapoolLowNm: "2.19", // Preserved from MTGJSON
      manapoolLowFoil: "4.35", // Supplemented from Mana Pool NM cents
      manapoolLowEtched: null, // 0 cents ignored
      ckBuylistCashNm: "1.35",
      ckBuylistCreditNm: "1.76",
      ckBuylistCashFoil: "2.50",
      ckBuylistCreditFoil: "3.25",
    });

    const [fonN1] = await db
      .select()
      .from(cardCatalog)
      .where(
        eq(cardCatalog.scryfallId, "0d840284-ce56-4e4f-822f-8b237a261d1e"),
      );
    expect(fonN1).toMatchObject({
      tcgplayerEtchedId: 276732,
      tcgMarketEtched: "46.80",
      manapoolLowEtched: "42.15",
      ckBuylistCashEtched: "30.00",
      ckBuylistCreditEtched: "39.00",
    });

    // Save a user collection lot referencing Lightning Bolt + add an expired SKU cache entry
    const savedLot = await createPersistedLot(db, {
      lotName: "Jon's Personal Binder",
      purchaseCostUsd: "5.00",
      csvText: [
        "Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency",
        `"Lightning Bolt",2X2,"Double Masters 2022",117,normal,uncommon,2,1,f29ba16f-c8fb-42fe-aabf-87089cb214a7,2.50,false,false,near_mint,en,USD`,
      ].join("\n"),
    });

    await db.insert(skuPriceCache).values({
      scryfallId: "f29ba16f-c8fb-42fe-aabf-87089cb214a7",
      finish: "normal",
      condition: "LP",
      retailLowUsd: "1.95",
      source: "justtcg",
      expiresAt: new Date(Date.now() - 60_000),
    });

    // Night 2 sync: Scryfall JSON array format, dropped CK buylist offers reset to NULL, unreachable Mana Pool handled gracefully
    const scryfallJsonArrayPath = path.join(tmpDir, "default-cards-array.json");
    fs.writeFileSync(scryfallJsonArrayPath, JSON.stringify(scryfallCards));

    const night2Stats = await syncFullCatalog(db, {
      scryfallSource: scryfallJsonArrayPath,
      skipIdentifiers: true,
      pricesSource: pricesNight2Bz2Path,
      manapoolSource: path.join(tmpDir, "non-existent-manapool.json"),
      ensureDemoSkuCache: false,
    });

    expect(night2Stats.manapoolFallbackFailed).toBe(true);
    expect(night2Stats.dailyPricesReset).toBeGreaterThanOrEqual(2);

    const [boltN2] = await db
      .select()
      .from(cardCatalog)
      .where(
        eq(cardCatalog.scryfallId, "f29ba16f-c8fb-42fe-aabf-87089cb214a7"),
      );
    expect(boltN2).toMatchObject({
      tcgMarketNm: "2.80",
      tcgMarketFoil: "4.80", // Refreshed from Scryfall usd_foil baseline when MTGJSON foil is omitted
      tcgLowNm: null, // Reset on Night 2
      ckBuylistCashNm: null, // Dropped CK buylist offer cleared instead of lingering!
      ckBuylistCreditNm: null,
    });

    // Saved collection_lots & lot_items remain 100% intact, and expired sku_price_cache was pruned
    const lotsRemaining = await db
      .select()
      .from(collectionLots)
      .where(eq(collectionLots.lotId, savedLot.lot.lotId));
    const itemsRemaining = await db
      .select()
      .from(lotItems)
      .where(eq(lotItems.lotId, savedLot.lot.lotId));
    const cacheRemaining = await db.select().from(skuPriceCache);
    expect(lotsRemaining).toHaveLength(1);
    expect(itemsRemaining).toHaveLength(1);
    expect(cacheRemaining).toHaveLength(0);
  });

  it("prevents overlapping sync runs via singleton manager, validates /api/catalog/sync payloads, and detaches activeLotId on New Collection Lot", async () => {
    const { db } = await getReadyDb();

    // Validate malformed POST /api/catalog/sync payloads -> HTTP 400
    const badModeRes = await postSyncRoute(
      new Request("http://localhost:3000/api/catalog/sync", {
        method: "POST",
        body: JSON.stringify({ mode: "bogus" }),
      }),
    );
    expect(badModeRes.status).toBe(400);

    const badLimitRes = await postSyncRoute(
      new Request("http://localhost:3000/api/catalog/sync", {
        method: "POST",
        body: JSON.stringify({ limit: -5 }),
      }),
    );
    expect(badLimitRes.status).toBe(400);

    // Concurrent startCatalogSyncJob calls share a single underlying promise
    const scryfallJsonPath = path.join(tmpDir, "mini.json");
    fs.writeFileSync(
      scryfallJsonPath,
      JSON.stringify([
        {
          id: "25b0b816-0583-44aa-9dc5-f3ff48993a51",
          oracle_id: "7c427c3d-ecd8-45ef-bebd-8f10f4a311db",
          name: "Gaea's Cradle",
          set: "usg",
          set_name: "Urza's Saga",
          collector_number: "321",
          rarity: "rare",
          games: ["paper"],
          finishes: ["nonfoil"],
          prices: { usd: "855.00" },
        },
      ]),
    );

    const run1 = await startCatalogSyncJob(db, {
      syncOptions: {
        scryfallSource: scryfallJsonPath,
        skipIdentifiers: true,
        skipPrices: true,
        skipManapool: true,
      },
    });
    const run2 = await startCatalogSyncJob(db, {
      syncOptions: {
        scryfallSource: scryfallJsonPath,
        skipIdentifiers: true,
        skipPrices: true,
        skipManapool: true,
      },
    });

    expect(run1.started).toBe(true);
    expect(run2.started).toBe(false);
    expect(run2.alreadyRunning).toBe(true);
    expect(run2.promise).toBe(run1.promise);

    await run1.promise;

    const getRes = await getSyncRoute();
    expect(getRes.status).toBe(200);
    const syncJson = await getRes.json();
    expect(syncJson.sync.state).toBe("completed");
    expect(syncJson.sync.lastSyncedAt).toBeTruthy();

    // Verify clean multi-collection workspace detachment helper
    const detached = createDetachedNewCollectionLotState({
      suggestedName: "Alex's Trade Binder",
    });
    expect(detached.activeLotId).toBeNull();
    expect(detached.activePresetId).toBeNull();
    expect(detached.lotName).toBe("Alex's Trade Binder");
    expect(detached.purchaseCostInput).toBe("0.00");
    expect(detached.serializedInputs).toEqual([]);
  });
});
