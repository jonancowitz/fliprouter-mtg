# FlipRouter MTG — Full Product & Technical Specification

## 1. Product Overview & Core Value Proposition
* **Product Name:** FlipRouter MTG (Backpack Vendor & Collection Flipper Triage Suite)
* **Target User:** Magic: The Gathering "backpack vendors," Facebook/Discord collection flippers, and high-volume hobbyist buyers who acquire collections at 50%–70% of market value and liquidate them across multiple channels.
* **Core Problem Solved:** Flippers bleed profit margin and hours of labor when deciding whether to sell a card as an individual marketplace single (TCGplayer, Mana Pool, eBay), ship it to a wholesale buylist (Card Kingdom, Card Conduit), sell it peer-to-peer (85% TCG Low on Discord/Facebook), or bulk it out.
* **Core Workflow:**
  1. User uploads a scanned collection CSV/TXT (from **ManaBox**, **Delver Lens**, **TCGplayer App**, or **Dragon Shield**).
  2. The backend resolves every row to an exact Scryfall `id` + finish (`normal`, `foil`, `etched`) + condition (`NM`, `LP`, `MP`, `HP`, `DMG`) + language/alteration flags (`language`, `is_altered`, `is_misprint`).
  3. The routing engine runs net-payout math across all liquidation channels—deducting exact platform fees, fixed per-order fees, shipping supplies/postage, outbound buylist box shipping, and user-configured packing labor value.
  4. The UI outputs **4 physical sorting piles** with 1-click export manifests formatted for each destination platform, plus proportional Fair Market Value (FMV) cost-basis allocation for IRS Schedule C COGS tracking.

---

## 2. Tech Stack & Hard Architectural Guardrails
* **Frontend & App Framework:** Next.js (App Router), TypeScript (strict mode), Tailwind CSS, shadcn/ui.
* **Backend & Routing Engine:** Next.js Server Actions / API Routes (TypeScript) for fast CRUD + Python 3.12 worker scripts (`polars` / `pandas` / `ijson`) for nightly 100k+ card bulk JSON ingestion.
* **Database, Auth & Billing:** PostgreSQL (via Supabase or Railway) + Drizzle ORM; Supabase Auth or Clerk; Stripe for subscriptions ($15/mo Starter, $29/mo Pro).
* **Hard Guardrails (NEVER Violate):**
  1. **NEVER scrape HTML pages** from TCGplayer, Card Kingdom, or eBay.
  2. **95% Local DB Rule:** Resolve all standard card lookups and Near Mint baseline pricing against the local PostgreSQL `card_catalog` table (populated nightly via Scryfall Bulk Data + MTGJSON `AllPricesToday.json` + Mana Pool public singles feed).
  3. **Selective Live SKU API Rule (5% of Queries — Pro Tier Only, 24h Cached):** Trigger external paid SKU APIs (**TCGAPIs** `tcgapis.com` or **JustTCG** `justtcg.com`) *only* when a card's finish-specific baseline Near Mint retail price is $\ge \$8.00$ OR when a user imports non-NM conditions (`LP`, `MP`, `HP`) on non-quarantined cards whose NM baseline could plausibly clear bulk (skipping already buylist-quarantined `DMG` rows and sub-dollar bulk so quota is never wasted). Always read/write `sku_price_cache` (24-hour TTL) and enforce `monthly_sku_api_quota` so interactive slider recalculations never re-bill paid condition APIs.
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
    tcg_low_etched NUMERIC(10, 2),
    manapool_low_nm NUMERIC(10, 2),
    manapool_low_foil NUMERIC(10, 2),
    manapool_low_etched NUMERIC(10, 2),
    
    -- Cached Nightly Wholesale Buylist (USD)
    ck_buylist_cash_nm NUMERIC(10, 2),
    ck_buylist_credit_nm NUMERIC(10, 2), -- Typically Cash * 1.30
    ck_buylist_cash_foil NUMERIC(10, 2),
    ck_buylist_credit_foil NUMERIC(10, 2),
    ck_buylist_cash_etched NUMERIC(10, 2),
    ck_buylist_credit_etched NUMERIC(10, 2),
    
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_card_lookup ON card_catalog (LOWER(set_code), collector_number);
CREATE INDEX idx_tcgplayer_id ON card_catalog (tcgplayer_id);
CREATE INDEX idx_tcgplayer_etched_id ON card_catalog (tcgplayer_etched_id);

-- 2. Selective Paid Condition/SKU Price Cache (24h TTL, Prevents Duplicate API Billing)
CREATE TABLE sku_price_cache (
    scryfall_id UUID NOT NULL REFERENCES card_catalog(scryfall_id) ON DELETE CASCADE,
    finish VARCHAR(16) NOT NULL, -- 'normal', 'foil', 'etched'
    condition VARCHAR(8) NOT NULL, -- 'NM', 'LP', 'MP', 'HP', 'DMG'
    retail_low_usd NUMERIC(10, 2),
    retail_market_usd NUMERIC(10, 2),
    buylist_cash_usd NUMERIC(10, 2),
    buylist_credit_usd NUMERIC(10, 2),
    source VARCHAR(32) NOT NULL, -- 'tcgapis' | 'justtcg'
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    PRIMARY KEY (scryfall_id, finish, condition)
);

CREATE INDEX idx_sku_price_cache_expires_at ON sku_price_cache (expires_at);

-- 3. User Cost & Routing Profile (Customizable per Flipper)
CREATE TABLE user_routing_profiles (
    user_id UUID PRIMARY KEY,
    hourly_labor_rate_usd NUMERIC(10, 2) NOT NULL DEFAULT 20.00,
    seconds_per_single_order INTEGER NOT NULL DEFAULT 180, -- 3 mins pick/pack/ship
    pwe_shipping_cost_usd NUMERIC(10, 2) NOT NULL DEFAULT 0.90, -- Stamp + envelope + toploader
    tracked_shipping_cost_usd NUMERIC(10, 2) NOT NULL DEFAULT 4.25, -- Bubble mailer + ground advantage
    tracked_threshold_usd NUMERIC(10, 2) NOT NULL DEFAULT 25.00, -- Force tracked shipping at $25+
    outbound_buylist_box_shipping_usd NUMERIC(10, 2) NOT NULL DEFAULT 12.00, -- Lot-level postage to ship a wholesale buylist box
    min_single_net_gain_over_buylist_usd NUMERIC(10, 2) NOT NULL DEFAULT 1.25, -- Buylist convenience threshold required to justify listing as a single
    enable_credit_arbitrage BOOLEAN NOT NULL DEFAULT FALSE,
    conduit_tier_preference VARCHAR(16) NOT NULL DEFAULT 'curated', -- 'sorted', 'curated', 'standard'
    monthly_sku_api_quota INTEGER NOT NULL DEFAULT 0, -- e.g. 0 Starter, 2500 Pro
    monthly_sku_api_used INTEGER NOT NULL DEFAULT 0,
    sku_api_quota_reset_at TIMESTAMPTZ NOT NULL DEFAULT (DATE_TRUNC('month', NOW()) + INTERVAL '1 month')
);

-- 4. Collection Acquisition Lots (For ROI & 1099 Schedule C Tracking)
CREATE TABLE collection_lots (
    lot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    lot_name TEXT NOT NULL,
    purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
    purchase_cost_usd NUMERIC(10, 2) NOT NULL,
    total_cards INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'draft', -- 'draft' | 'routed' | 'shipped' | 'settled'
    estimated_gross_value_usd NUMERIC(10, 2),
    estimated_net_payout_usd NUMERIC(10, 2),
    actual_realized_payout_usd NUMERIC(10, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Routed Line Items within a Lot
CREATE TABLE lot_items (
    item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lot_id UUID NOT NULL REFERENCES collection_lots(lot_id) ON DELETE CASCADE,
    scryfall_id UUID REFERENCES card_catalog(scryfall_id),
    quantity INTEGER NOT NULL DEFAULT 1,
    finish VARCHAR(16) NOT NULL DEFAULT 'normal', -- 'normal', 'foil', 'etched'
    condition VARCHAR(8) NOT NULL DEFAULT 'NM', -- 'NM', 'LP', 'MP', 'HP', 'DMG'
    language VARCHAR(16) NOT NULL DEFAULT 'en', -- ISO code; non-'en' quarantined from automated buylists
    is_altered BOOLEAN NOT NULL DEFAULT FALSE,
    is_misprint BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Proportional FMV Line-Item Cost Basis (IRS Schedule C COGS; sums to collection_lots.purchase_cost_usd)
    allocated_cost_basis_usd NUMERIC(10, 2),
    
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

### A. Condition Multipliers & Buylist Quarantine Guardrails
* **Retail Multipliers (Fallback When Using Cached NM Baseline):**
  * `NM = 1.00`, `LP = 0.88`, `MP = 0.72`, `HP = 0.52`, `DMG = 0.35`
* **Wholesale Buylist Multipliers (Card Kingdom / Card Conduit grading standards):**
  * `NM = 1.00`, `LP (EX) = 0.80`, `MP (VG) = 0.65`, `HP (G) = 0.50`, `DMG = 0.00`
  * *Foil/Etched Wear Penalty:* Non-NM `foil` and `etched` cards (`LP`, `MP`, `HP`) receive an additional `0.90` multiplier penalty because wholesale vendors heavily downgrade scuffed foils.
* **Automated Buylist Quarantine (`DMG`, Foreign, Altered, Misprint):**
  * Any row where `condition == 'DMG'`, `LOWER(language) != 'en'`, `is_altered == true`, or `is_misprint == true` is **strictly ineligible** for `PILE_1_BUYLIST` and `PILE_3_CREDIT_ARB` (`P_buy = $0.00`, `Net_CK_Cash = $0.00`, `Net_Conduit_* = $0.00`, `Net_Credit_Arb = $0.00`). Such items route to `PILE_2_SINGLES` (manual specialty/damaged listing) if $\max(\text{Net}_{\text{TCG}}, \text{Net}_{\text{MP}}, \text{Net}_{\text{P2P}}) \ge \$0.75$, else `PILE_4_BULK`.

### B. Channel Baseline Price Hierarchy & Net Payout Equations (Per Card)

#### 1. Baseline NM Price Resolution (Before Condition Multiplier or `sku_price_cache` Override)
If a fresh (`expires_at > NOW()`) exact `(scryfall_id, finish, condition)` record exists in `sku_price_cache`, use each non-null cached channel quote (`retail_market_usd`, `retail_low_usd`, `buylist_cash_usd`, `buylist_credit_usd`) directly without applying NM fallback multipliers; if any individual cached column is `NULL` (for example, a retail SKU API response with `buylist_cash_usd IS NULL`), fall back for that missing channel to the condition-adjusted `card_catalog` baseline below rather than treating `NULL` as `0.00`. Otherwise resolve Near Mint baseline prices from `card_catalog` by `finish` and multiply by the §4.A condition multiplier *(note: Scryfall Bulk Data and MTGJSON v5 `AllPricesToday` populate `tcg_market_*`, leaving `tcg_low_*` `NULL` unless populated by an optional low-price feed, so `COALESCE` deterministically uses `tcg_market_*` locally when `tcg_low_*` is `NULL`)*:
* **TCGplayer Single Retail ($P_{\text{retail\_TCG}}$):**
  * `normal`: `COALESCE(tcg_market_nm, tcg_low_nm)`
  * `foil`: `COALESCE(tcg_market_foil, tcg_low_foil)`
  * `etched`: `COALESCE(tcg_market_etched, tcg_low_etched, tcg_market_foil)`
* **Mana Pool Single Retail ($P_{\text{retail\_MP}}$):**
  * `normal`: `COALESCE(manapool_low_nm, tcg_low_nm, tcg_market_nm)`
  * `foil`: `COALESCE(manapool_low_foil, tcg_low_foil, tcg_market_foil)`
  * `etched`: `COALESCE(manapool_low_etched, tcg_low_etched, tcg_market_etched, tcg_low_foil, tcg_market_foil)`
* **Discord / Facebook P2P Benchmark ($P_{\text{retail\_P2P}}$ — "TCG Low" Basis):**
  * `normal`: `COALESCE(tcg_low_nm, tcg_market_nm)`
  * `foil`: `COALESCE(tcg_low_foil, tcg_market_foil)`
  * `etched`: `COALESCE(tcg_low_etched, tcg_market_etched, tcg_low_foil, tcg_market_foil)`
* **Wholesale Buylist Cash ($P_{\text{buy\_CK}}$ / $P_{\text{buy}}$):**
  * `normal`: `COALESCE(ck_buylist_cash_nm, 0.00)`
  * `foil`: `COALESCE(ck_buylist_cash_foil, 0.00)`
  * `etched`: `COALESCE(ck_buylist_cash_etched, 0.00)` (never blindly assume foil buylist when an etched buylist quote is absent, unless populated by `cardkingdom.buylist.etched` or `sku_price_cache`).

#### 2. Per-Card Channel Net Payout Formulas
Let $C_{\text{labor}} = \left(\frac{\text{seconds\_per\_single\_order}}{3600}\right) \times \text{hourly\_labor\_rate\_usd}$ (defaults to $\frac{180}{3600} \times \$20 = \$1.00$ per order).
For each retail channel $X \in \{\text{TCG}, \text{MP}, \text{P2P}\}$ with sale price $P_{\text{sale}, X}$, let $C_{\text{ship}}(P_{\text{sale}, X}) = \$0.90$ (`pwe_shipping_cost_usd`) if $P_{\text{sale}, X} < \text{tracked\_threshold\_usd}$ ($\$25.00$), else $\$4.25$ (`tracked_shipping_cost_usd`).

1. **TCGplayer Individual Single Net ($\text{Net}_{\text{TCG}}$):**
   * Platform Commission: $10.75\%$ **capped at $\$75.00$** + Payment Processing: $2.5\% + \$0.30$ (equals $13.25\% + \$0.30$ up to $\$697.67$):
   $$\text{Net}_{\text{TCG}} = P_{\text{retail\_TCG}} - \min\left(P_{\text{retail\_TCG}} \times 0.1075,\ \$75.00\right) - \left(P_{\text{retail\_TCG}} \times 0.025\right) - \$0.30 - C_{\text{ship}}(P_{\text{retail\_TCG}}) - C_{\text{labor}}$$

2. **Mana Pool Individual Single Net ($\text{Net}_{\text{MP}}$):**
   * Platform Commission: $5.0\%$ + Processing: $2.9\% + \$0.30$ = **$7.9\% + \$0.30$**:
   $$\text{Net}_{\text{MP}} = P_{\text{retail\_MP}} \times (1 - 0.079) - \$0.30 - C_{\text{ship}}(P_{\text{retail\_MP}}) - C_{\text{labor}}$$

3. **Facebook / Discord P2P "85% TCG Low" Claim Sale ($\text{Net}_{\text{P2P}}$):**
   * Sold at $85\%$ of $P_{\text{retail\_P2P}}$ via PayPal G&S ($\approx 3.5\%$ fee drag), with half the per-card packing labor due to multi-card claim bundling:
   $$\text{Net}_{\text{P2P}} = \left(P_{\text{retail\_P2P}} \times 0.85\right) \times (1 - 0.035) - C_{\text{ship}}(P_{\text{retail\_P2P}} \times 0.85) - \left(0.5 \times C_{\text{labor}}\right)$$

4. **Direct Wholesale Buylist Cash Net ($\text{Net}_{\text{Buylist\_Cash}}$):**
   * **Card Kingdom Direct Cash (`ck_cash`):** $\text{Net}_{\text{CK\_Cash}} = P_{\text{buy\_CK}}$
   * **Card Conduit Sorted Service (`conduit_sorted` — 2% fee, $0/card, requires $P_{\text{buy}} \ge \$0.50$, max 500 cards/shipment):**
     $$\text{Net}_{\text{Conduit\_Sorted}} = P_{\text{buy}} \times 0.98$$
   * **Card Conduit Curated Service (`conduit_curated` — 5% fee, $0/card, requires $\ge 90\%$ of cards to have $P_{\text{buy}} \ge \$0.50$):**
     $$\text{Net}_{\text{Conduit\_Curated}} = P_{\text{buy}} \times 0.95$$
   * **Card Conduit Standard Service (`conduit_standard` — 10% fee + $\$0.03$/card):**
     $$\text{Net}_{\text{Conduit\_Standard}} = \max\left(\$0.00,\ P_{\text{buy}} \times 0.90 - \$0.03\right)$$
   * Let $\text{Net}_{\text{Buylist\_Cash}} = \max(\text{Net}_{\text{CK\_Cash}}, \text{Net}_{\text{Conduit\_Tier}})$ for the user's configured `conduit_tier_preference` (`0.00` if buylist-quarantined). When using local `card_catalog` alone ($P_{\text{buy}} = P_{\text{buy\_CK}}$), $\text{Net}_{\text{CK\_Cash}}$ (`ck_cash`) maximizes unit cash payout while `lot_items.net_conduit_curated` records $\text{Net}_{\text{Conduit\_Curated}}$ for side-by-side manifest comparison; multi-vendor `sku_price_cache.buylist_cash_usd` quotes or explicit Conduit manifest export use the configured Conduit tier.

5. **Store-Credit "Up-Trade" Realized Cash Value ($\text{Net}_{\text{Credit\_Arb}}$):**
   * Card Kingdom offers $+30\%$ store credit ($P_{\text{buy\_CK}} \times 1.30$, or explicit `ck_buylist_credit_*`). Converted into liquid sealed boxes or Reserved List staples at an $0.82$ cash-to-credit conversion ratio:
     $$\text{Net}_{\text{Credit\_Arb}} = \text{Credit}_{\text{CK}} \times 0.82 \quad \text{(typically } (P_{\text{buy\_CK}} \times 1.30) \times 0.82 = P_{\text{buy\_CK}} \times 1.066\text{)}$$

### C. Deterministic 4-Bucket Decision Tree (Strict Evaluation Order)
Let $\text{Net}_{\text{BestSingle}} = \max(\text{Net}_{\text{TCG}}, \text{Net}_{\text{MP}}, \text{Net}_{\text{P2P}})$ and $\tau = \text{min\_single\_net\_gain\_over\_buylist\_usd}$ (the `buylist_convenience_threshold`, default $\$1.25$).

1. **Step 1 — Bucket 4 (`PILE_4_BULK` — Quarantine & Bulk Guardrail):**
   * **Trigger:** $P_{\text{buy}} < \$0.50$ (including buylist-quarantined items where $P_{\text{buy}} = \$0.00$) AND $\text{Net}_{\text{BestSingle}} < \$0.75$.
   * **Action:** Quarantine from Card Conduit Curated/Sorted shipments so the user never breaches the $90\%$ $\ge \$0.50$ threshold (which would downgrade the shipment to Standard Service's $10\% + \$0.03/\text{card}$ penalty). Route $P_{\text{retail}} \in [\$0.50, \$1.49]$ to local $.50/\$1$ binder box (`binder_local`) and $< \$0.50$ to $\$3.00/1,000$ wholesale bulk (`bulk_wholesale`).
2. **Step 2 — Bucket 3 (`PILE_3_CREDIT_ARB` — Store-Credit Up-Trade Pool):**
   * **Trigger:** Item is buylist-eligible (`condition != 'DMG'`, `language == 'en'`, `!is_altered`, `!is_misprint`, $P_{\text{buy\_CK}} \ge \$0.50$) AND `enable_credit_arbitrage == true` AND $\text{Net}_{\text{Credit\_Arb}} > \text{Net}_{\text{Buylist\_Cash}}$ AND $\left(\text{Net}_{\text{BestSingle}} - \text{Net}_{\text{Credit\_Arb}}\right) < \tau$.
   * **Action:** Route to Card Kingdom Store Credit manifest (`ck_credit`; evaluated *before* `PILE_1_BUYLIST` so enabled credit up-trades capture mid-tier buylist cards whose $1.066\times$ realized value beats cash buylist and comes within $\tau$ of best singles/P2P net).
3. **Step 3 — Bucket 1 (`PILE_1_BUYLIST` — Zero-Labor Wholesale Cash Out):**
   * **Trigger:** Item is buylist-eligible ($P_{\text{buy}} \ge \$0.50$) AND $\left(\text{Net}_{\text{BestSingle}} - \text{Net}_{\text{Buylist\_Cash}}\right) < \tau$ (default $\$1.25$).
   * **Action:** Route to Card Kingdom Cash (`ck_cash`) or Card Conduit Sorted/Curated/Standard manifest (`conduit_sorted` / `conduit_curated` / `conduit_standard`).
4. **Step 4 — Bucket 2 (`PILE_2_SINGLES` — High-Margin Singles & P2P Lot):**
   * **Trigger:** All remaining cards (where $\text{Net}_{\text{BestSingle}} \ge \text{Buylist/Credit} + \tau$, or buylist-quarantined / sub-$\$0.50$-buylist cards with $\text{Net}_{\text{BestSingle}} \ge \$0.75$).
   * **Action:** Assign `recommended_channel` to $\arg\max(\text{Net}_{\text{TCG}}, \text{Net}_{\text{MP}}, \text{Net}_{\text{P2P}})$ and route to TCGplayer Staged CSV, Mana Pool Staged CSV, or Discord/FB $85\%$ claim-sale Markdown generator.

### D. Lot-Level Outbound Buylist Box Shipping & Schedule C Cost Basis
* **Lot-Level Buylist Box Postage Guardrail (`outbound_buylist_box_shipping_usd`, default `$12.00`):**
  * After item-level bucket assignment, deduct `outbound_buylist_box_shipping_usd` once per distinct outbound wholesale buylist box (combined into one `$12.00` box when `PILE_1_BUYLIST` (`ck_cash`) and `PILE_3_CREDIT_ARB` (`ck_credit`) both ship to Card Kingdom, or one `$12.00` box per vendor when `PILE_1_BUYLIST` ships to Card Conduit and `PILE_3_CREDIT_ARB` ships to Card Kingdom). Evaluate compatible active vendor-box subsets (`Card Kingdom`, `Card Conduit`, both, or neither) through the §4.C decision tree so any vendor buylist box whose incremental payout does not strictly exceed `outbound_buylist_box_shipping_usd` automatically cascades its eligible items into the surviving buylist vendor box (when profitable) or re-routes them to their non-buylist fallback (`PILE_2_SINGLES` if $\text{Net}_{\text{BestSingle}} \ge \$0.75$, else `PILE_4_BULK`), preferring fewer outbound boxes on exact ties.
* **IRS Schedule C Proportional FMV Cost Basis (`allocated_cost_basis_usd`):**
  * Given lot acquisition cost $C_{\text{lot}} = \text{purchase\_cost\_usd}$ and each line item's initial condition-adjusted unit retail Fair Market Value $V_i$ with quantity $q_i$ (letting $V_{\text{total}} = \sum_j q_j V_j$), `lot_items.allocated_cost_basis_usd` stores the **line-item** allocated cost basis:
    $$\text{allocated\_cost\_basis\_usd}_i = \begin{cases} C_{\text{lot}} \times \dfrac{q_i V_i}{V_{\text{total}}} & \text{if } V_{\text{total}} > 0 \\ 0.00 & \text{otherwise} \end{cases}$$
    reconciled in exact integer cents via Largest-Remainder (Hamilton) allocation so $\sum_i \text{allocated\_cost\_basis\_usd}_i = \text{purchase\_cost\_usd}$ across every `quantity >= 1` lot whenever $V_{\text{total}} > 0$ (exposing per-copy $\text{round}(\text{allocated\_cost\_basis\_usd}_i / q_i)$ for unit display and splitting partial-row sales across tax periods as $\text{round}(\text{allocated\_cost\_basis\_usd}_i \times q_{\text{sold}} / q_i)$ with the exact cent remainder retained on the unsold copies), alongside lot-level `status` (`draft | routed | shipped | settled`) and `actual_realized_payout_usd`.

---

## 5. Scanner CSV Normalization & Export Manifest Specs

### Input Scanner Normalization
Auto-detect scanner format by CSV headers and normalize to `{ scryfallId, tcgplayerProductId, setCode, collectorNumber, finish, condition, language, isAltered, isMisprint, quantity }` *(normalizing full language labels case-insensitively across all scanners into short Scryfall/ISO codes $\le 16$ chars for `lot_items.language`: `English` $\rightarrow$ `en`, `Japanese` $\rightarrow$ `ja`, `German` $\rightarrow$ `de`, `French` $\rightarrow$ `fr`, `Italian` $\rightarrow$ `it`, `Spanish` $\rightarrow$ `es`, `Portuguese` / `Portuguese (Brazil)` $\rightarrow$ `pt`, `Korean` $\rightarrow$ `ko`, `Russian` $\rightarrow$ `ru`, `Chinese Simplified` / `Chinese (Simplified)` / `Simplified Chinese` $\rightarrow$ `zhs`, `Chinese Traditional` / `Chinese (Traditional)` / `Traditional Chinese` $\rightarrow$ `zht`, `Phyrexian` $\rightarrow$ `ph`, truncating unknown codes to 16 chars)*:
* **ManaBox:** Headers `Name, Set code, Set name, Collector number, Foil, Rarity, Quantity, ManaBox ID, Scryfall ID, Purchase price, Misprint, Altered, Condition, Language, Purchase price currency`. Read `Scryfall ID` directly. Map `Foil` (`normal`, `foil`, `etched`; also map Scryfall `'nonfoil'` $\leftrightarrow$ `'normal'` when validating `card_catalog.finishes`). Map `Condition` (`near_mint` $\rightarrow$ `NM`, `lightly_played` $\rightarrow$ `LP`, `moderately_played` $\rightarrow$ `MP`, `heavily_played` $\rightarrow$ `HP`, `damaged` $\rightarrow$ `DMG`). Map `Language` (`en` default), `Altered` boolean $\rightarrow$ `isAltered`, and `Misprint` boolean $\rightarrow$ `isMisprint`.
* **Delver Lens:** Headers `Name, Edition, Edition code, Collector's number, Price, Foil, Quantity, Scryfall ID, Condition` (optional `Language`). Read `Scryfall ID` directly. Normalize `Foil` boolean/string (`Foil`/`true` $\rightarrow$ `foil`, `Etched` $\rightarrow$ `etched`, empty/`false` $\rightarrow$ `normal`).
* **TCGplayer App:** Headers `Quantity, Name, Simple Name, Set, Card Number, Set Code, Printing, Condition, Language, Rarity, Product ID, SKU`. Match `Product ID` $\rightarrow$ `card_catalog.tcgplayer_id` (or `tcgplayer_etched_id` if `Printing` contains `Etched`). Fallback to `(LOWER(Set Code), Card Number)`. Normalize `Language` to ISO code (`en` default).
* **Dragon Shield:** Headers `Folder Name, Quantity, Trade Quantity, Card Name, Set Code, Set Name, Card Number, Condition, Printing, Language, Price Bought, Date Bought, LOW, MID, MARKET`. Normalize Dragon Shield set-code/collector-number quirks (lowercase `Set Code`, strip promo `p` prefix fallback if direct set match misses, trim collector number whitespace), resolve via `(LOWER(set_code), collector_number)` against `card_catalog`, map `Printing` (`Normal` $\rightarrow$ `normal`, `Foil` $\rightarrow$ `foil`, `Etched`/`Foil Etched` $\rightarrow$ `etched`), map `Condition` (`Mint`/`NearMint` $\rightarrow$ `NM`, `LightlyPlayed`/`Excellent` $\rightarrow$ `LP`, `ModeratelyPlayed`/`Played` $\rightarrow$ `MP`, `HeavilyPlayed`/`Poor` $\rightarrow$ `HP`, `Damaged` $\rightarrow$ `DMG`), and normalize `Language` to ISO code (`English` $\rightarrow$ `en`).

### Output Manifests
All CSV manifest serializers escape embedded commas, double quotes (`""`), and newlines per RFC-4180 and neutralize spreadsheet formula-injection prefixes (`=`, `+`, `-`, `@`, `\t`, `\r`, or leading spaces before `=+-@`, excluding plain negative decimals) by prepending `'` inside double quotes (`"'..."`).
1. **Card Conduit CSV Export (`PILE_1_BUYLIST`):**
   * Columns: `Quantity, Name, Set Code, Collector Number, Finish, Condition, Scryfall ID`.
   * **Curated Service Validation:** Validate that $\ge 90\%$ of total quantity in the file has $P_{\text{buy}} \ge \$0.50$.
   * **Sorted Service 500-Card Cap:** Validate $100\%$ of cards have $P_{\text{buy}} \ge \$0.50$, sort descending by $P_{\text{buy}}$, and split shipments exceeding `500` total cards (`SUM(quantity) > 500`) into numbered batch CSVs (`card-conduit-sorted-batch-1.csv`, `card-conduit-sorted-batch-2.csv`, ...) with at most `500` total cards per file.
2. **Card Kingdom Buylist Import CSV (`PILE_1_BUYLIST` / `PILE_3_CREDIT_ARB`):**
   * Columns: `Card Name, Edition, Foil, Quantity` (`Foil` is `true` for `foil`/`etched`, `false` for `normal`).
3. **TCGplayer Staged Inventory CSV Export (`PILE_2_SINGLES` $\rightarrow$ `tcgplayer_single`):**
   * Columns: `TCGplayer Id, Product Line, Set Name, Product Name, Title, Number, Rarity, Condition, TCG Market Price, TCG Direct Low, TCG Low Price With Shipping, TCG Low Price, Total Quantity, Add to Quantity, TCG Marketplace Price, My Store Reserve Quantity, My Store Price, Photo URL`.
   * Populates `TCGplayer Id` (`tcgplayer_etched_id` when `finish == 'etched'`, else `tcgplayer_id`), `Product Line` = `Magic`, `Condition` (`Near Mint`, `Lightly Played`, `Moderately Played`, `Heavily Played`, `Damaged`, appending ` Foil` when `finish != 'normal'`), `Add to Quantity` = `quantity`, and `TCG Marketplace Price` = condition-adjusted $P_{\text{retail\_TCG}}$.
4. **Mana Pool Staged Singles CSV Export (`PILE_2_SINGLES` $\rightarrow$ `manapool_single`):**
   * Columns: `Scryfall ID, TCGplayer ID, Set Code, Collector Number, Name, Finish, Condition, Language, Quantity, Price USD`.
   * Populates `Scryfall ID`, `Finish` (`normal | foil | etched`), `Condition` (`NM | LP | MP | HP | DMG`), `Language`, `Quantity`, and `Price USD` = condition-adjusted $P_{\text{retail\_MP}}$.
5. **Discord / Facebook "85% TCG Low" Claim Post Generator (`PILE_2_SINGLES` $\rightarrow$ `p2p_85_pct`):**
   * Outputs copy-pasteable Markdown grouped by price tier:
     `1x [Card Name] (Set Code #CollectorNum - Condition/Finish) — TCG Low: $XX.XX -> Claim: $YY.YY`

---

## 6. Nightly Data Sync Cron Pipeline (04:00 UTC)
1. Fetch `https://api.scryfall.com/bulk-data/default-cards` $\rightarrow$ stream-parse JSON/JSONL using `ijson` (never load 450MB into memory at once) and upsert `scryfall_id`, `tcgplayer_id`, `tcgplayer_etched_id`, set metadata, and Scryfall baseline prices (`usd`, `usd_foil`, `usd_etched`).
2. Fetch `https://mtgjson.com/api/v5/AllIdentifiers.json.bz2` (weekly or on set release) to map `scryfallId` $\leftrightarrow$ `mtgjson_uuid` (primary face `side in (None, 'a')`) and Card Kingdom / TCGplayer product IDs.
3. Fetch `https://mtgjson.com/api/v5/AllPricesToday.json.bz2` $\rightarrow$ reset prior daily vendor-quote columns (`tcg_low_*`, `manapool_low_*`, `ck_buylist_*`) so dropped buylist offers never linger across days, then stream-parse `data[mtgjson_uuid].paper` to extract `tcgplayer.retail` (`tcg_market_*`; `tcg_low_*` remains `NULL` unless provided by a low-price series), `cardkingdom.buylist` (computing store credit as `Cash * 1.30` when explicit credit series are absent), and `manapool.retail` across `normal`, `foil`, and `etched`.
4. Supplement missing Near Mint Mana Pool printings/finishes (`price_cents_nm`, `price_cents_nm_foil`, `price_cents_nm_etched` $\rightarrow$ `normal`, `foil`, `etched`, never falling back to non-NM `HP`/`DMG` floor prices) by streaming Mana Pool's public singles feed (`https://manapool.com/api/v1/prices/singles`, optional `--skip-manapool` flag and graceful non-fatal fallback if unreachable) keyed directly by `scryfall_id`.
5. Bulk upsert/update `card_catalog` in PostgreSQL in batches of 5,000 rows (`ON CONFLICT (scryfall_id) DO UPDATE`), and prune expired `sku_price_cache` entries (`expires_at <= NOW()`).
