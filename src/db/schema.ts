import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const CARD_FINISHES = ["normal", "foil", "etched"] as const;
export type CardFinish = (typeof CARD_FINISHES)[number];

export const CATALOG_FINISHES = ["nonfoil", "foil", "etched"] as const;
export type CatalogFinish = (typeof CATALOG_FINISHES)[number];

export function toCatalogFinish(finish: CardFinish): CatalogFinish {
  return finish === "normal" ? "nonfoil" : finish;
}

export function fromCatalogFinish(rawFinish: string): CardFinish {
  const normalized = rawFinish.trim().toLowerCase();
  if (normalized === "etched" || normalized === "foil etched") {
    return "etched";
  }
  if (normalized === "foil") {
    return "foil";
  }
  return "normal";
}

export const CARD_CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type CardCondition = (typeof CARD_CONDITIONS)[number];

export const ASSIGNED_BUCKETS = [
  "PILE_1_BUYLIST",
  "PILE_2_SINGLES",
  "PILE_3_CREDIT_ARB",
  "PILE_4_BULK",
] as const;
export type AssignedBucket = (typeof ASSIGNED_BUCKETS)[number];

export const RECOMMENDED_CHANNELS = [
  "tcgplayer_single",
  "manapool_single",
  "p2p_85_pct",
  "ck_cash",
  "ck_credit",
  "conduit_sorted",
  "conduit_curated",
  "conduit_standard",
  "binder_local",
  "bulk_wholesale",
] as const;
export type RecommendedChannel =
  | (typeof RECOMMENDED_CHANNELS)[number]
  | (string & {});

export const CONDUIT_TIERS = ["sorted", "curated", "standard"] as const;
export type ConduitTierPreference = (typeof CONDUIT_TIERS)[number];

export const COLLECTION_LOT_STATUSES = [
  "draft",
  "routed",
  "shipped",
  "settled",
] as const;
export type CollectionLotStatus = (typeof COLLECTION_LOT_STATUSES)[number];

export const SKU_PRICE_SOURCES = ["tcgapis", "justtcg"] as const;
export type SkuPriceSource = (typeof SKU_PRICE_SOURCES)[number] | (string & {});

const usdNumeric = (columnName: string) =>
  numeric(columnName, { precision: 10, scale: 2 });

/**
 * 1. Canonical Card Catalog & Daily Price Cache (Synced Nightly via Cron)
 */
export const cardCatalog = pgTable(
  "card_catalog",
  {
    scryfallId: uuid("scryfall_id").primaryKey(),
    mtgjsonUuid: uuid("mtgjson_uuid").unique(),
    oracleId: uuid("oracle_id").notNull(),
    tcgplayerId: integer("tcgplayer_id"),
    tcgplayerEtchedId: integer("tcgplayer_etched_id"),
    cardkingdomId: integer("cardkingdom_id"),
    cardkingdomFoilId: integer("cardkingdom_foil_id"),
    name: text("name").notNull(),
    setCode: varchar("set_code", { length: 16 }).notNull(),
    setName: text("set_name").notNull(),
    collectorNumber: varchar("collector_number", { length: 32 }).notNull(),
    rarity: varchar("rarity", { length: 16 }).notNull(),
    finishes: text("finishes").array().notNull(),
    imageUri: text("image_uri"),

    // Cached Nightly Retail Low/Market (USD)
    tcgMarketNm: usdNumeric("tcg_market_nm"),
    tcgLowNm: usdNumeric("tcg_low_nm"),
    tcgMarketFoil: usdNumeric("tcg_market_foil"),
    tcgLowFoil: usdNumeric("tcg_low_foil"),
    tcgMarketEtched: usdNumeric("tcg_market_etched"),
    tcgLowEtched: usdNumeric("tcg_low_etched"),
    manapoolLowNm: usdNumeric("manapool_low_nm"),
    manapoolLowFoil: usdNumeric("manapool_low_foil"),
    manapoolLowEtched: usdNumeric("manapool_low_etched"),

    // Cached Nightly Wholesale Buylist (USD)
    ckBuylistCashNm: usdNumeric("ck_buylist_cash_nm"),
    ckBuylistCreditNm: usdNumeric("ck_buylist_credit_nm"),
    ckBuylistCashFoil: usdNumeric("ck_buylist_cash_foil"),
    ckBuylistCreditFoil: usdNumeric("ck_buylist_credit_foil"),
    ckBuylistCashEtched: usdNumeric("ck_buylist_cash_etched"),
    ckBuylistCreditEtched: usdNumeric("ck_buylist_credit_etched"),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_card_lookup").on(
      sql`LOWER(${table.setCode})`,
      table.collectorNumber,
    ),
    index("idx_tcgplayer_id").on(table.tcgplayerId),
    index("idx_tcgplayer_etched_id").on(table.tcgplayerEtchedId),
  ],
);

/**
 * 2. Selective Paid Condition/SKU Price Cache (24h TTL, Prevents Duplicate API Billing)
 */
export const skuPriceCache = pgTable(
  "sku_price_cache",
  {
    scryfallId: uuid("scryfall_id")
      .notNull()
      .references(() => cardCatalog.scryfallId, { onDelete: "cascade" }),
    finish: varchar("finish", { length: 16 }).$type<CardFinish>().notNull(),
    condition: varchar("condition", { length: 8 })
      .$type<CardCondition>()
      .notNull(),
    retailLowUsd: usdNumeric("retail_low_usd"),
    retailMarketUsd: usdNumeric("retail_market_usd"),
    buylistCashUsd: usdNumeric("buylist_cash_usd"),
    buylistCreditUsd: usdNumeric("buylist_credit_usd"),
    source: varchar("source", { length: 32 }).$type<SkuPriceSource>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .default(sql`NOW() + INTERVAL '24 hours'`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "sku_price_cache_pkey",
      columns: [table.scryfallId, table.finish, table.condition],
    }),
    index("idx_sku_price_cache_expires_at").on(table.expiresAt),
  ],
);

/**
 * 3. User Cost & Routing Profile (Customizable per Flipper)
 */
export const userRoutingProfiles = pgTable("user_routing_profiles", {
  userId: uuid("user_id").primaryKey(),
  hourlyLaborRateUsd: usdNumeric("hourly_labor_rate_usd")
    .notNull()
    .default("20.00"),
  secondsPerSingleOrder: integer("seconds_per_single_order")
    .notNull()
    .default(180),
  pweShippingCostUsd: usdNumeric("pwe_shipping_cost_usd")
    .notNull()
    .default("0.90"),
  trackedShippingCostUsd: usdNumeric("tracked_shipping_cost_usd")
    .notNull()
    .default("4.25"),
  trackedThresholdUsd: usdNumeric("tracked_threshold_usd")
    .notNull()
    .default("25.00"),
  outboundBuylistBoxShippingUsd: usdNumeric(
    "outbound_buylist_box_shipping_usd",
  )
    .notNull()
    .default("12.00"),
  minSingleNetGainOverBuylistUsd: usdNumeric(
    "min_single_net_gain_over_buylist_usd",
  )
    .notNull()
    .default("1.25"),
  enableCreditArbitrage: boolean("enable_credit_arbitrage")
    .notNull()
    .default(false),
  conduitTierPreference: varchar("conduit_tier_preference", { length: 16 })
    .$type<ConduitTierPreference>()
    .notNull()
    .default("curated"),
  monthlySkuApiQuota: integer("monthly_sku_api_quota").notNull().default(0),
  monthlySkuApiUsed: integer("monthly_sku_api_used").notNull().default(0),
  skuApiQuotaResetAt: timestamp("sku_api_quota_reset_at", {
    withTimezone: true,
  })
    .notNull()
    .default(sql`DATE_TRUNC('month', NOW()) + INTERVAL '1 month'`),
});

/**
 * 4. Collection Acquisition Lots (For ROI & 1099 Schedule C Tracking)
 */
export const collectionLots = pgTable(
  "collection_lots",
  {
    lotId: uuid("lot_id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    lotName: text("lot_name").notNull(),
    purchaseDate: date("purchase_date")
      .notNull()
      .default(sql`CURRENT_DATE`),
    purchaseCostUsd: usdNumeric("purchase_cost_usd").notNull(),
    totalCards: integer("total_cards").notNull().default(0),
    status: varchar("status", { length: 16 })
      .$type<CollectionLotStatus>()
      .notNull()
      .default("draft"),
    estimatedGrossValueUsd: usdNumeric("estimated_gross_value_usd"),
    estimatedNetPayoutUsd: usdNumeric("estimated_net_payout_usd"),
    actualRealizedPayoutUsd: usdNumeric("actual_realized_payout_usd"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_collection_lots_user_id").on(table.userId)],
);

/**
 * 5. Routed Line Items within a Lot
 */
export const lotItems = pgTable(
  "lot_items",
  {
    itemId: uuid("item_id").primaryKey().defaultRandom(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => collectionLots.lotId, { onDelete: "cascade" }),
    scryfallId: uuid("scryfall_id").references(() => cardCatalog.scryfallId),
    quantity: integer("quantity").notNull().default(1),
    finish: varchar("finish", { length: 16 })
      .$type<CardFinish>()
      .notNull()
      .default("normal"),
    condition: varchar("condition", { length: 8 })
      .$type<CardCondition>()
      .notNull()
      .default("NM"),
    language: varchar("language", { length: 16 }).notNull().default("en"),
    isAltered: boolean("is_altered").notNull().default(false),
    isMisprint: boolean("is_misprint").notNull().default(false),

    // Proportional FMV Line-Item Cost Basis (IRS Schedule C COGS; sums to collection_lots.purchase_cost_usd)
    allocatedCostBasisUsd: usdNumeric("allocated_cost_basis_usd"),

    // Computed Channel Net Payouts (Per Single Copy)
    netTcgplayerSingle: usdNumeric("net_tcgplayer_single"),
    netManapoolSingle: usdNumeric("net_manapool_single"),
    netP2p85Pct: usdNumeric("net_p2p_85_pct"),
    netCkCash: usdNumeric("net_ck_cash"),
    netCkCredit: usdNumeric("net_ck_credit"),
    netConduitCurated: usdNumeric("net_conduit_curated"),

    // Assigned Bucket ('PILE_1_BUYLIST', 'PILE_2_SINGLES', 'PILE_3_CREDIT_ARB', 'PILE_4_BULK')
    assignedBucket: varchar("assigned_bucket", { length: 32 })
      .$type<AssignedBucket>()
      .notNull(),
    recommendedChannel: varchar("recommended_channel", {
      length: 32,
    })
      .$type<RecommendedChannel>()
      .notNull(),
    optimalUnitNetUsd: usdNumeric("optimal_unit_net_usd").notNull(),
  },
  (table) => [
    index("idx_lot_items_lot_id").on(table.lotId),
    index("idx_lot_items_scryfall_id").on(table.scryfallId),
  ],
);

export const cardCatalogRelations = relations(cardCatalog, ({ many }) => ({
  lotItems: many(lotItems),
  skuPrices: many(skuPriceCache),
}));

export const skuPriceCacheRelations = relations(skuPriceCache, ({ one }) => ({
  card: one(cardCatalog, {
    fields: [skuPriceCache.scryfallId],
    references: [cardCatalog.scryfallId],
  }),
}));

export const collectionLotsRelations = relations(
  collectionLots,
  ({ many }) => ({
    items: many(lotItems),
  }),
);

export const lotItemsRelations = relations(lotItems, ({ one }) => ({
  lot: one(collectionLots, {
    fields: [lotItems.lotId],
    references: [collectionLots.lotId],
  }),
  card: one(cardCatalog, {
    fields: [lotItems.scryfallId],
    references: [cardCatalog.scryfallId],
  }),
}));

export type CardCatalogItem = typeof cardCatalog.$inferSelect;
export type NewCardCatalogItem = typeof cardCatalog.$inferInsert;

export type SkuPriceCacheItem = typeof skuPriceCache.$inferSelect;
export type NewSkuPriceCacheItem = typeof skuPriceCache.$inferInsert;

export type UserRoutingProfile = typeof userRoutingProfiles.$inferSelect;
export type NewUserRoutingProfile = typeof userRoutingProfiles.$inferInsert;

export type CollectionLot = typeof collectionLots.$inferSelect;
export type NewCollectionLot = typeof collectionLots.$inferInsert;

export type LotItem = typeof lotItems.$inferSelect;
export type NewLotItem = typeof lotItems.$inferInsert;
