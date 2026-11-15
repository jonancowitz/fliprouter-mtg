CREATE TABLE "sku_price_cache" (
	"scryfall_id" uuid NOT NULL,
	"finish" varchar(16) NOT NULL,
	"condition" varchar(8) NOT NULL,
	"retail_low_usd" numeric(10, 2),
	"retail_market_usd" numeric(10, 2),
	"buylist_cash_usd" numeric(10, 2),
	"buylist_credit_usd" numeric(10, 2),
	"source" varchar(32) NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT NOW() + INTERVAL '24 hours' NOT NULL,
	CONSTRAINT "sku_price_cache_pkey" PRIMARY KEY("scryfall_id","finish","condition")
);
--> statement-breakpoint
ALTER TABLE "card_catalog" ADD COLUMN "tcg_low_etched" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "card_catalog" ADD COLUMN "manapool_low_etched" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "card_catalog" ADD COLUMN "ck_buylist_cash_etched" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "card_catalog" ADD COLUMN "ck_buylist_credit_etched" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "collection_lots" ADD COLUMN "status" varchar(16) DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_lots" ADD COLUMN "actual_realized_payout_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "lot_items" ADD COLUMN "language" varchar(16) DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "lot_items" ADD COLUMN "is_altered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lot_items" ADD COLUMN "is_misprint" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lot_items" ADD COLUMN "allocated_cost_basis_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "user_routing_profiles" ADD COLUMN "outbound_buylist_box_shipping_usd" numeric(10, 2) DEFAULT '12.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_routing_profiles" ADD COLUMN "monthly_sku_api_quota" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_routing_profiles" ADD COLUMN "monthly_sku_api_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_routing_profiles" ADD COLUMN "sku_api_quota_reset_at" timestamp with time zone DEFAULT DATE_TRUNC('month', NOW()) + INTERVAL '1 month' NOT NULL;--> statement-breakpoint
ALTER TABLE "sku_price_cache" ADD CONSTRAINT "sku_price_cache_scryfall_id_card_catalog_scryfall_id_fk" FOREIGN KEY ("scryfall_id") REFERENCES "public"."card_catalog"("scryfall_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sku_price_cache_expires_at" ON "sku_price_cache" USING btree ("expires_at");