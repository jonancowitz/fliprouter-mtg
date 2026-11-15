import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import {
  buildDemoSkuPriceCacheSeeds,
  DEMO_CATALOG_CARDS,
  DEMO_USER_ID,
} from "./demo-cards";
import { closeDb, type Database, getReadyDb } from "./index";
import {
  cardCatalog,
  skuPriceCache,
  userRoutingProfiles,
} from "./schema";

export interface SeedDemoResult {
  alreadySeeded: boolean;
  catalogCountBefore: number;
  insertedCatalogCount: number;
  insertedSkuCacheCount: number;
  demoUserId: string;
}

export async function getCatalogCount(db: Database): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
    .from(cardCatalog);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Upserts the 44-card demo MTG catalog, 24h `sku_price_cache` fixtures,
 * and default prototype `user_routing_profiles` row (`monthlySkuApiQuota = 2500`).
 */
export async function seedDemoCatalog(
  db: Database,
  options: { now?: Date } = {},
): Promise<SeedDemoResult> {
  const now = options.now ?? new Date();
  const catalogCountBefore = await getCatalogCount(db);

  for (const card of DEMO_CATALOG_CARDS) {
    await db
      .insert(cardCatalog)
      .values({ ...card, updatedAt: now })
      .onConflictDoUpdate({
        target: cardCatalog.scryfallId,
        set: {
          mtgjsonUuid: card.mtgjsonUuid,
          oracleId: card.oracleId,
          tcgplayerId: card.tcgplayerId,
          tcgplayerEtchedId: card.tcgplayerEtchedId,
          cardkingdomId: card.cardkingdomId,
          cardkingdomFoilId: card.cardkingdomFoilId,
          name: card.name,
          setCode: card.setCode,
          setName: card.setName,
          collectorNumber: card.collectorNumber,
          rarity: card.rarity,
          finishes: card.finishes,
          imageUri: card.imageUri,
          tcgMarketNm: card.tcgMarketNm,
          tcgLowNm: card.tcgLowNm,
          tcgMarketFoil: card.tcgMarketFoil,
          tcgLowFoil: card.tcgLowFoil,
          tcgMarketEtched: card.tcgMarketEtched,
          tcgLowEtched: card.tcgLowEtched,
          manapoolLowNm: card.manapoolLowNm,
          manapoolLowFoil: card.manapoolLowFoil,
          manapoolLowEtched: card.manapoolLowEtched,
          ckBuylistCashNm: card.ckBuylistCashNm,
          ckBuylistCreditNm: card.ckBuylistCreditNm,
          ckBuylistCashFoil: card.ckBuylistCashFoil,
          ckBuylistCreditFoil: card.ckBuylistCreditFoil,
          ckBuylistCashEtched: card.ckBuylistCashEtched,
          ckBuylistCreditEtched: card.ckBuylistCreditEtched,
          updatedAt: now,
        },
      });
  }

  const skuSeeds = buildDemoSkuPriceCacheSeeds(now);
  for (const sku of skuSeeds) {
    await db
      .insert(skuPriceCache)
      .values(sku)
      .onConflictDoUpdate({
        target: [
          skuPriceCache.scryfallId,
          skuPriceCache.finish,
          skuPriceCache.condition,
        ],
        set: {
          retailLowUsd: sku.retailLowUsd,
          retailMarketUsd: sku.retailMarketUsd,
          buylistCashUsd: sku.buylistCashUsd,
          buylistCreditUsd: sku.buylistCreditUsd,
          source: sku.source,
          fetchedAt: sku.fetchedAt,
          expiresAt: sku.expiresAt,
        },
      });
  }

  await db
    .insert(userRoutingProfiles)
    .values({
      userId: DEMO_USER_ID,
      hourlyLaborRateUsd: "20.00",
      secondsPerSingleOrder: 180,
      pweShippingCostUsd: "0.90",
      trackedShippingCostUsd: "4.25",
      trackedThresholdUsd: "25.00",
      outboundBuylistBoxShippingUsd: "12.00",
      minSingleNetGainOverBuylistUsd: "1.25",
      enableCreditArbitrage: false,
      conduitTierPreference: "curated",
      monthlySkuApiQuota: 2500,
      monthlySkuApiUsed: 2,
    })
    .onConflictDoNothing({ target: userRoutingProfiles.userId });

  return {
    alreadySeeded: catalogCountBefore > 0,
    catalogCountBefore,
    insertedCatalogCount: DEMO_CATALOG_CARDS.length,
    insertedSkuCacheCount: skuSeeds.length,
    demoUserId: DEMO_USER_ID,
  };
}

export async function seedDemoCatalogIfEmpty(
  db: Database,
  options: { now?: Date } = {},
): Promise<SeedDemoResult> {
  const catalogCountBefore = await getCatalogCount(db);
  if (catalogCountBefore > 0) {
    return {
      alreadySeeded: true,
      catalogCountBefore,
      insertedCatalogCount: 0,
      insertedSkuCacheCount: 0,
      demoUserId: DEMO_USER_ID,
    };
  }
  return seedDemoCatalog(db, options);
}

async function runCliSeed(): Promise<void> {
  try {
    const { db, mode } = await getReadyDb({ autoSeed: false });
    const result = await seedDemoCatalog(db);
    process.stdout.write(
      `[fliprouter:seed] Seeded ${result.insertedCatalogCount} catalog printings + ${result.insertedSkuCacheCount} 24h SKU cache quotes (${mode} mode).\n`,
    );
  } finally {
    await closeDb();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runCliSeed().catch((err: unknown) => {
    console.error("[fliprouter:seed] Failed:", err);
    process.exitCode = 1;
  });
}
