# FlipRouter MTG — Full Product & Technical Specification

## 1. Product Overview & Core Value Proposition
* **Product Name:** FlipRouter MTG (Backpack Vendor & Collection Flipper Triage Suite)
* **Target User:** Magic: The Gathering "backpack vendors," Facebook/Discord collection flippers, and high-volume hobbyist buyers who acquire collections at 50%–70% of market value and liquidate them across multiple channels.
* **Core Problem Solved:** Flippers bleed profit margin and hours of labor when deciding whether to sell a card as an individual marketplace single (TCGplayer, Mana Pool, eBay), ship it to a wholesale buylist (Card Kingdom, Card Conduit), sell it peer-to-peer (85% TCG Low on Discord/Facebook), or bulk it out.
* **Core Workflow:**
  1. User uploads a scanned collection CSV/TXT (from **ManaBox**, **Delver Lens**, **TCGplayer App**, or **Dragon Shield**).
  2. The backend resolves every row to an exact Scryfall `id` + finish (`normal`, `foil`, `etched`) + condition (`NM`, `LP`, `MP`, `HP`, `DMG`).
  3. The routing engine runs net-payout math across all liquidation channels—deducting exact platform fees, fixed per-order fees, shipping supplies/postage, and user-configured packing labor value.
  4. The UI outputs **4 physical sorting piles** with 1-click export manifests formatted for each destination platform.

---

## 2. Tech Stack & Hard Architectural Guardrails
* **Frontend & App Framework:** Next.js (App Router), TypeScript (strict mode), Tailwind CSS, shadcn/ui.
* **Backend & Routing Engine:** Next.js Server Actions / API Routes (TypeScript) for fast CRUD + Python 3.12 worker scripts (`polars` / `pandas` / `ijson`) for nightly 100k+ card bulk JSON ingestion.
* **Database, Auth & Billing:** PostgreSQL (via Supabase or Railway) + Drizzle ORM; Supabase Auth or Clerk; Stripe for subscriptions ($15/mo Starter, $29/mo Pro).
* **Hard Guardrails (NEVER Violate):**
  1. **NEVER scrape HTML pages** from TCGplayer, Card Kingdom, or eBay.
  2. **95% Local DB Rule:** Resolve all standard card lookups and Near Mint baseline pricing against the local PostgreSQL `card_catalog` table (populated nightly via Scryfall Bulk Data + MTGJSON `AllPricesToday.json`).
  3. **Selective Live SKU API Rule (5% of Queries — Pro Tier Only):** Trigger external paid SKU APIs (**TCGAPIs** `tcgapis.com` or **JustTCG** `justtcg.com`) *only* when a card's baseline Near Mint retail price is $\ge \$8.00$ OR when a user imports non-NM conditions (`LP`, `MP`, `HP`) where condition spread materially alters the flip math.
  4. **No Floating-Point Currency Math:** Always use integer cents or `Decimal` / `NUMERIC(10,2)` for fee and payout calculations—never raw JavaScript floating-point math.

---

## 3. Core Database Schema (PostgreSQL DDL)

```sql
-- 1. Canonical Card Catalog & Daily Price Cache (Synced Nightly via Cron)
CREATE TABLE card_catalog (
    scryfall_id UUID PRIMARY KEY,
    mtgjson_uuid UUID UNIQUE,
    oracle_id UUID NOT NULL,
    tcgplayer_id INTEGER,
    tcgplayer_etched_id INTEGER,
    cardkingdom_id INTEGER,
    cardkingdom_foil_id INTEGER,
    name TEXT NOT NULL,
    set_code VARCHAR(16) NOT NULL,
    set_name TEXT NOT NULL,
    collector_number VARCHAR(32) NOT NULL,
    rarity VARCHAR(16) NOT NULL,
    finishes TEXT[] NOT NULL, -- e.g. {'nonfoil', 'foil', 'etched'}
    image_uri TEXT,
    
    -- Cached Nightly Retail Low/Market (USD)
    tcg_market_nm NUMERIC(10, 2),
    tcg_low_nm NUMERIC(10, 2),
    tcg_market_foil NUMERIC(10, 2),
    tcg_low_foil NUMERIC(10, 2),
    tcg_market_etched NUMERIC(10, 2),
    manapool_low_nm NUMERIC(10, 2),
    manapool_low_foil NUMERIC(10, 2),
    
    -- Cached Nightly Wholesale Buylist (USD)
    ck_buylist_cash_nm NUMERIC(10, 2),
    ck_buylist_credit_nm NUMERIC(10, 2), -- Typically Cash * 1.30
    ck_buylist_cash_foil NUMERIC(10, 2),
    ck_buylist_credit_foil NUMERIC(10, 2),
    
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_card_lookup ON card_catalog (LOWER(set_code), collector_number);
CREATE INDEX idx_tcgplayer_id ON card_catalog (tcgplayer_id);

-- 2. User Cost & Routing Profile (Customizable per Flipper)
CREATE TABLE user_routing_profiles (
    user_id UUID PRIMARY KEY,
    hourly_labor_rate_usd NUMERIC(6, 2) DEFAULT 20.00,
    seconds_per_single_order INTEGER DEFAULT 180, -- 3 mins pick/pack/ship
    pwe_shipping_cost_usd NUMERIC(5, 2) DEFAULT 0.90, -- Stamp + envelope + toploader
    tracked_shipping_cost_usd NUMERIC(5, 2) DEFAULT 4.25, -- Bubble mailer + ground advantage
    tracked_threshold_usd NUMERIC(6, 2) DEFAULT 25.00, -- Force tracked shipping at $25+
    min_single_net_gain_over_buylist_usd NUMERIC(5, 2) DEFAULT 1.25, -- Extra profit required to justify listing as a single instead of buylisting
    enable_credit_arbitrage BOOLEAN DEFAULT FALSE,
    conduit_tier_preference VARCHAR(16) DEFAULT 'curated' -- 'sorted', 'curated', 'standard'
);

-- 3. Collection Acquisition Lots (For ROI & 1099 Schedule C Tracking)
CREATE TABLE collection_lots (
    lot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    lot_name TEXT NOT NULL,
    purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
    purchase_cost_usd NUMERIC(10, 2) NOT NULL,
    total_cards INTEGER NOT NULL DEFAULT 0,
    estimated_gross_value_usd NUMERIC(10, 2),
    estimated_net_payout_usd NUMERIC(10, 2),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Routed Line Items within a Lot
CREATE TABLE lot_items (
    item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lot_id UUID REFERENCES collection_lots(lot_id) ON DELETE CASCADE,
    scryfall_id UUID REFERENCES card_catalog(scryfall_id),
    quantity INTEGER NOT NULL DEFAULT 1,
    finish VARCHAR(16) NOT NULL DEFAULT 'normal', -- 'normal', 'foil', 'etched'
    condition VARCHAR(8) NOT NULL DEFAULT 'NM', -- 'NM', 'LP', 'MP', 'HP', 'DMG'
    
    -- Computed Channel Net Payouts (Per Single Copy)
    net_tcgplayer_single NUMERIC(10, 2),
    net_manapool_single NUMERIC(10, 2),
    net_p2p_85_pct NUMERIC(10, 2),
    net_ck_cash NUMERIC(10, 2),
    net_ck_credit NUMERIC(10, 2),
    net_conduit_curated NUMERIC(10, 2),
    
    -- Assigned Bucket ('PILE_1_BUYLIST', 'PILE_2_SINGLES', 'PILE_3_CREDIT_ARB', 'PILE_4_BULK')
    assigned_bucket VARCHAR(32) NOT NULL,
    recommended_channel VARCHAR(32) NOT NULL,
    optimal_unit_net_usd NUMERIC(10, 2) NOT NULL
);
```

---

## 4. Deterministic Fee Constants & Mathematical Routing Engine

Every card row uploaded in a CSV is evaluated against these exact rules:

### A. Condition Multipliers (Fallback When Using Cached NM Baseline)
* **Retail Multipliers:** `NM = 1.00`, `LP = 0.88`, `MP = 0.72`, `HP = 0.52`, `DMG = 0.35`
* **Wholesale Buylist Multipliers (Card Kingdom / Card Conduit grading standards):**
  * `NM = 1.00`, `LP (EX) = 0.80`, `MP (VG) = 0.65`, `HP (G) = 0.50` *(Non-NM foils receive an additional `0.90` multiplier penalty because vendors heavily downgrade scuffed foils).*

### B. Channel Net Payout Equations (Per Card)
Let $P_{\text{retail}}$ be the condition-adjusted TCGplayer Low / Market price, and $P_{\text{buy}}$ be the condition-adjusted wholesale buylist cash price.
Let $C_{\text{labor}} = \left(\frac{\text{seconds\_per\_single\_order}}{3600}\right) \times \text{hourly\_labor\_rate\_usd}$ (defaults to $\frac{180}{3600} \times \$20 = \$1.00$ per order).
Let $C_{\text{ship}} = \$0.90$ (`pwe_shipping_cost_usd`) if $P_{\text{retail}} < \$25.00$, else $\$4.25$ (`tracked_shipping_cost_usd`).

1. **TCGplayer Individual Single Net ($\text{Net}_{\text{TCG}}$):**
   * Platform Commission: $10.75\%$ (capped at $\$75.00$) + Payment Processing: $2.5\% + \$0.30$ = **$13.25\% + \$0.30$**.
   $$\text{Net}_{\text{TCG}} = P_{\text{retail}} \times (1 - 0.1325) - \$0.30 - C_{\text{ship}} - C_{\text{labor}}$$

2. **Mana Pool Individual Single Net ($\text{Net}_{\text{MP}}$):**
   * Platform Commission: $5.0\%$ + Processing: $2.9\% + \$0.30$ = **$7.9\% + \$0.30$**.
   $$\text{Net}_{\text{MP}} = P_{\text{retail}} \times (1 - 0.079) - \$0.30 - C_{\text{ship}} - C_{\text{labor}}$$

3. **Facebook / Discord P2P "85% TCG Low" Claim Sale ($\text{Net}_{\text{P2P}}$):**
   * Sold at $85\%$ of $P_{\text{retail}}$ via PayPal G&S ($\approx 3.5\%$ fee drag), with half the per-card packing labor due to multi-card claim bundling:
   $$\text{Net}_{\text{P2P}} = \left(P_{\text{retail}} \times 0.85\right) \times (1 - 0.035) - C_{\text{ship}} - \left(0.5 \times C_{\text{labor}}\right)$$

4. **Direct Wholesale Buylist Net ($\text{Net}_{\text{Buylist}}$):**
   * **Card Kingdom Direct Cash:** $\text{Net}_{\text{CK\_Cash}} = P_{\text{buy\_CK}}$
   * **Card Conduit Sorted Service (2% fee, $0/card, requires $P_{\text{buy}} \ge \$0.50$, max 500 cards):**
     $$\text{Net}_{\text{Conduit\_Sorted}} = P_{\text{buy}} \times 0.98$$
   * **Card Conduit Curated Service (5% fee, $0/card, requires $\ge 90\%$ of cards to have $P_{\text{buy}} \ge \$0.50$):**
     $$\text{Net}_{\text{Conduit\_Curated}} = P_{\text{buy}} \times 0.95$$

5. **Store-Credit "Up-Trade" Realized Cash Value ($\text{Net}_{\text{Credit\_Arb}}$):**
   * Card Kingdom offers $+30\%$ store credit ($P_{\text{buy\_CK}} \times 1.30$). Converted into liquid sealed boxes or Reserved List staples at an $0.82$ cash-to-credit conversion ratio:
     $$\text{Net}_{\text{Credit\_Arb}} = \left(P_{\text{buy\_CK}} \times 1.30\right) \times 0.82 = P_{\text{buy\_CK}} \times 1.066$$

### C. Deterministic 4-Bucket Decision Tree (Strict Evaluation Order)
1. **Bucket 4 (`PILE_4_BULK` — Quarantine & Bulk Guardrail):**
   * **Trigger:** $P_{\text{buy}} < \$0.50$ AND $\max(\text{Net}_{\text{TCG}}, \text{Net}_{\text{MP}}) < \$0.75$.
   * **Action:** Quarantine from Card Conduit Curated/Sorted shipments so the user never breaches the $90\%$ $\ge \$0.50$ threshold (which would downgrade the shipment to Standard Service's $10\% + \$0.03/\text{card}$ penalty). Route $P_{\text{retail}} \in [\$0.50, \$1.49]$ to local $.50/\$1$ binder box and $< \$0.50$ to $\$3.00/1,000$ wholesale bulk.
2. **Bucket 1 (`PILE_1_BUYLIST` — Zero-Labor Wholesale Cash Out):**
   * **Trigger:** $P_{\text{buy}} \ge \$0.50$ AND $\left(\max(\text{Net}_{\text{TCG}}, \text{Net}_{\text{MP}}, \text{Net}_{\text{P2P}}) - \text{Net}_{\text{Buylist}}\right) < \text{min\_single\_net\_gain\_over\_buylist\_usd}$ (default $\$1.25$).
   * **Action:** Route to Card Kingdom Cash or Card Conduit Sorted/Curated manifest.
3. **Bucket 3 (`PILE_3_CREDIT_ARB` — Store-Credit Up-Trade Pool):**
   * **Trigger:** `enable_credit_arbitrage == true` AND $\text{Net}_{\text{Credit\_Arb}} > \max(\text{Net}_{\text{TCG}}, \text{Net}_{\text{MP}})$.
   * **Action:** Route to Card Kingdom Store Credit manifest.
4. **Bucket 2 (`PILE_2_SINGLES` — High-Margin Singles & P2P Lot):**
   * **Trigger:** All remaining cards where $\max(\text{Net}_{\text{TCG}}, \text{Net}_{\text{MP}}, \text{Net}_{\text{P2P}}) \ge \text{Net}_{\text{Buylist}} + \$1.25$ (typically $\$12.00+$ staples or wide-spread foils).
   * **Action:** Route to TCGplayer/Mana Pool staged CSV export or Discord/FB $85\%$ claim-sale markdown generator.

---

## 5. Scanner CSV Normalization & Export Manifest Specs

### Input Scanner Normalization
Auto-detect scanner format by CSV headers and normalize to `{ scryfallId, setCode, collectorNumber, finish, condition, quantity }`:
* **ManaBox:** Headers `Name, Set code, Set name, Collector number, Foil, Rarity, Quantity, ManaBox ID, Scryfall ID, Purchase price, Misprint, Altered, Condition, Language, Purchase price currency`. Read `Scryfall ID` directly. Map `Foil` (`normal`, `foil`, `etched`). Map `Condition` (`near_mint` $\rightarrow$ `NM`, `lightly_played` $\rightarrow$ `LP`, `moderately_played` $\rightarrow$ `MP`, `heavily_played` $\rightarrow$ `HP`, `damaged` $\rightarrow$ `DMG`).
* **Delver Lens:** Headers `Name, Edition, Edition code, Collector's number, Price, Foil, Quantity, Scryfall ID, Condition`. Read `Scryfall ID` directly. Normalize `Foil` boolean/string (`Foil`/`true` $\rightarrow$ `foil`, empty/`false` $\rightarrow$ `normal`).
* **TCGplayer App:** Headers `Quantity, Name, Simple Name, Set, Card Number, Set Code, Printing, Condition, Language, Rarity, Product ID, SKU`. Match `Product ID` $\rightarrow$ `card_catalog.tcgplayer_id` (or `tcgplayer_etched_id` if `Printing` contains `Etched`). Fallback to `(LOWER(Set Code), Card Number)`.

### Output Manifests
1. **Card Conduit CSV Export (`PILE_1_BUYLIST`):** Columns `Quantity, Name, Set Code, Collector Number, Finish, Condition, Scryfall ID`. Validate that $\ge 90\%$ of total quantity in the file has $P_{\text{buy}} \ge \$0.50$.
2. **Card Kingdom Buylist Import CSV (`PILE_1_BUYLIST` / `PILE_3_CREDIT_ARB`):** Columns `Card Name, Edition, Foil, Quantity` (`Foil` is `true` or `false`).
3. **Discord / Facebook "85% TCG Low" Claim Post Generator (`PILE_2_SINGLES`):** Outputs copy-pasteable Markdown grouped by price tier:
   `1x [Card Name] (Set Code #CollectorNum - Condition/Finish) — TCG Low: $XX.XX -> Claim: $YY.YY`

---

## 6. Nightly Data Sync Cron Pipeline (04:00 UTC)
1. Fetch `https://api.scryfall.com/bulk-data/default-cards` $\rightarrow$ stream-parse JSON using `ijson` (never load 450MB into memory at once) and upsert `scryfall_id`, `tcgplayer_id`, set metadata, and Scryfall baseline prices.
2. Fetch `https://mtgjson.com/api/v5/AllIdentifiers.json.bz2` (weekly or on set release) to map `scryfallId` $\leftrightarrow$ `mtgjson_uuid`.
3. Fetch `https://mtgjson.com/api/v5/AllPricesToday.json.bz2` $\rightarrow$ stream-parse `data[mtgjson_uuid].paper` to extract `tcgplayer.retail`, `cardkingdom.buylist`, and `manapool.retail` for `normal` and `foil`.
4. Bulk upsert `card_catalog` in PostgreSQL in batches of 5,000 rows (`ON CONFLICT (scryfall_id) DO UPDATE`).
