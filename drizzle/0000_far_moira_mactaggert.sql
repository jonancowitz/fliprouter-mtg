CREATE TABLE "card_catalog" (
	"scryfall_id" uuid PRIMARY KEY NOT NULL,
	"mtgjson_uuid" uuid,
	"oracle_id" uuid NOT NULL,
	"tcgplayer_id" integer,
	"tcgplayer_etched_id" integer,
	"cardkingdom_id" integer,
	"cardkingdom_foil_id" integer,
	"name" text NOT NULL,
	"set_code" varchar(16) NOT NULL,
	"set_name" text NOT NULL,
	"collector_number" varchar(32) NOT NULL,
	"rarity" varchar(16) NOT NULL,
	"finishes" text[] NOT NULL,
	"image_uri" text,
	"tcg_market_nm" numeric(10, 2),
	"tcg_low_nm" numeric(10, 2),
	"tcg_market_foil" numeric(10, 2),
	"tcg_low_foil" numeric(10, 2),
	"tcg_market_etched" numeric(10, 2),
	"manapool_low_nm" numeric(10, 2),
	"manapool_low_foil" numeric(10, 2),
	"ck_buylist_cash_nm" numeric(10, 2),
	"ck_buylist_credit_nm" numeric(10, 2),
	"ck_buylist_cash_foil" numeric(10, 2),
	"ck_buylist_credit_foil" numeric(10, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_catalog_mtgjson_uuid_unique" UNIQUE("mtgjson_uuid")
);
--> statement-breakpoint
CREATE TABLE "collection_lots" (
	"lot_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"lot_name" text NOT NULL,
	"purchase_date" date DEFAULT CURRENT_DATE NOT NULL,
	"purchase_cost_usd" numeric(10, 2) NOT NULL,
	"total_cards" integer DEFAULT 0 NOT NULL,
	"estimated_gross_value_usd" numeric(10, 2),
	"estimated_net_payout_usd" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lot_items" (
	"item_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"scryfall_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"finish" varchar(16) DEFAULT 'normal' NOT NULL,
	"condition" varchar(8) DEFAULT 'NM' NOT NULL,
	"net_tcgplayer_single" numeric(10, 2),
	"net_manapool_single" numeric(10, 2),
	"net_p2p_85_pct" numeric(10, 2),
	"net_ck_cash" numeric(10, 2),
	"net_ck_credit" numeric(10, 2),
	"net_conduit_curated" numeric(10, 2),
	"assigned_bucket" varchar(32) NOT NULL,
	"recommended_channel" varchar(32) NOT NULL,
	"optimal_unit_net_usd" numeric(10, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_routing_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"hourly_labor_rate_usd" numeric(10, 2) DEFAULT '20.00' NOT NULL,
	"seconds_per_single_order" integer DEFAULT 180 NOT NULL,
	"pwe_shipping_cost_usd" numeric(10, 2) DEFAULT '0.90' NOT NULL,
	"tracked_shipping_cost_usd" numeric(10, 2) DEFAULT '4.25' NOT NULL,
	"tracked_threshold_usd" numeric(10, 2) DEFAULT '25.00' NOT NULL,
	"min_single_net_gain_over_buylist_usd" numeric(10, 2) DEFAULT '1.25' NOT NULL,
	"enable_credit_arbitrage" boolean DEFAULT false NOT NULL,
	"conduit_tier_preference" varchar(16) DEFAULT 'curated' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lot_items" ADD CONSTRAINT "lot_items_lot_id_collection_lots_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."collection_lots"("lot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_items" ADD CONSTRAINT "lot_items_scryfall_id_card_catalog_scryfall_id_fk" FOREIGN KEY ("scryfall_id") REFERENCES "public"."card_catalog"("scryfall_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_card_lookup" ON "card_catalog" USING btree (LOWER("set_code"),"collector_number");--> statement-breakpoint
CREATE INDEX "idx_tcgplayer_id" ON "card_catalog" USING btree ("tcgplayer_id");--> statement-breakpoint
CREATE INDEX "idx_tcgplayer_etched_id" ON "card_catalog" USING btree ("tcgplayer_etched_id");--> statement-breakpoint
CREATE INDEX "idx_collection_lots_user_id" ON "collection_lots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_lot_items_lot_id" ON "lot_items" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "idx_lot_items_scryfall_id" ON "lot_items" USING btree ("scryfall_id");