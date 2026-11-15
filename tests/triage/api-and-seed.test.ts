import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GET as getCatalogStatus,
  POST as reseedCatalog,
} from "@/app/api/catalog/status/route";
import {
  DELETE as deleteLotRoute,
  GET as getLotByIdRoute,
  PATCH as patchLotRoute,
} from "@/app/api/lots/[lotId]/route";
import {
  GET as listLotsRoute,
  POST as createLotRoute,
} from "@/app/api/lots/route";
import {
  GET as getProfileRoute,
  PATCH as patchProfileRoute,
} from "@/app/api/profile/route";
import { POST as triagePostRoute } from "@/app/api/triage/route";
import { resolveConduitDrawerView } from "@/components/triage/export-drawer";
import { cardCatalog, closeDb, getDbMode, getReadyDb } from "@/db";
import { DEMO_CATALOG_CARDS } from "@/db/demo-cards";
import { getCatalogCount, seedDemoCatalogIfEmpty } from "@/db/seed-demo";
import {
  CsvParseError,
  generateAllLotExports,
  parseScannerCsv,
} from "@/lib/csv";
import { DEMO_SCANNER_PRESETS } from "@/lib/demo/scanner-presets";
import { parseUsdToCents, routeCollectionLot } from "@/lib/routing";
import {
  getPersistedLotById,
  hydrateRoutingCardInputs,
  hydrateRoutingProfile,
  ingestAndRouteScannerCsv,
  MAX_CSV_BYTES,
  updatePersistedLot,
} from "@/lib/triage";

describe("Step 4 Zero-Config PGlite Fallback, Demo Seed, & Triage API Routes", () => {
  const prevDbUrl = process.env.DATABASE_URL;
  const prevPgliteDir = process.env.PGLITE_DATA_DIR;

  beforeEach(async () => {
    await closeDb();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = "memory://";
  });

  afterEach(async () => {
    await closeDb();
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

  it("auto-migrates and auto-seeds local PGlite catalog without cold-boot autoSeed:false poisoning (M1)", async () => {
    expect(getDbMode()).toBe("pglite");

    // Cold-boot call with autoSeed: false must migrate cleanly without poisoning subsequent autoSeed: true calls
    const coldNoSeed = await getReadyDb({ autoSeed: false });
    expect(coldNoSeed.mode).toBe("pglite");
    expect(coldNoSeed.seededCount).toBe(0);
    expect(await getCatalogCount(coldNoSeed.db)).toBe(0);

    // Partial catalog (< 44 cards) must still be completed atomically by seedDemoCatalogIfEmpty
    await coldNoSeed.db.insert(cardCatalog).values(DEMO_CATALOG_CARDS[0]!);
    expect(await getCatalogCount(coldNoSeed.db)).toBe(1);

    const ready = await getReadyDb();
    expect(ready.mode).toBe("pglite");
    expect(ready.seededCount).toBe(44);
    expect(await getCatalogCount(ready.db)).toBe(44);

    // Subsequent seedDemoCatalogIfEmpty is a fast no-op
    const noop = await seedDemoCatalogIfEmpty(ready.db);
    expect(noop.alreadySeeded).toBe(true);
    expect(noop.insertedCatalogCount).toBe(0);

    const statusRes = await getCatalogStatus();
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as {
      ok: boolean;
      dbMode: string;
      catalogCount: number;
      freshSkuCacheCount: number;
    };
    expect(statusJson.ok).toBe(true);
    expect(statusJson.dbMode).toBe("pglite");
    expect(statusJson.catalogCount).toBe(44);
    expect(statusJson.freshSkuCacheCount).toBe(2);

    // Idempotent re-seed via POST /api/catalog/status
    const reseedRes = await reseedCatalog();
    expect(reseedRes.status).toBe(200);
    const reseedJson = (await reseedRes.json()) as {
      catalogCount: number;
      alreadySeeded: boolean;
    };
    expect(reseedJson.alreadySeeded).toBe(true);
    expect(reseedJson.catalogCount).toBe(44);
  });

  it("resolves all 4 scanner CSV presets with accurate card counts (L1), 4 piles, Credit Arb, & $12 Postage Guard", async () => {
    expect(DEMO_SCANNER_PRESETS[0]!.subtitle).toContain("36 rows / 81 cards");
    expect(DEMO_SCANNER_PRESETS[3]!.subtitle).toContain(
      "4 buylist cards (3 SKUs)",
    );

    for (const preset of DEMO_SCANNER_PRESETS) {
      const req = new Request("http://localhost:3000/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csvText: preset.csvText,
          purchaseCostUsd: preset.suggestedPurchaseCostUsd,
        }),
      });
      const res = await triagePostRoute(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.diagnostics.scannerFormat).toBe(preset.format);
      expect(data.diagnostics.unresolvedRowCount).toBe(0);
      expect(data.diagnostics.totalResolvedRows).toBe(
        data.diagnostics.totalParsedRows,
      );
      expect(data.summary.allocatedCostBasisSumUsd).toBe(
        data.summary.purchaseCostUsd,
      );

      if (preset.id === "manabox-weekend-buy") {
        expect(data.summary.totalCards).toBe(81);
        expect(data.summary.buckets.PILE_1_BUYLIST.totalCards).toBeGreaterThan(
          0,
        );
        expect(data.summary.buckets.PILE_2_SINGLES.totalCards).toBeGreaterThan(
          0,
        );
        expect(data.summary.buckets.PILE_3_CREDIT_ARB.totalCards).toBe(0);
        expect(data.summary.buckets.PILE_4_BULK.totalCards).toBeGreaterThan(0);
        expect(data.diagnostics.freshSkuCacheHitCount).toBe(2);

        const reroutedWithCredit = routeCollectionLot({
          purchaseCostUsd: preset.suggestedPurchaseCostUsd,
          items: hydrateRoutingCardInputs(data.inputs),
          profile: {
            ...hydrateRoutingProfile(data.profile),
            enableCreditArbitrage: true,
          },
        });
        expect(
          reroutedWithCredit.summary.buckets.PILE_3_CREDIT_ARB.totalCards,
        ).toBeGreaterThan(0);
        expect(
          reroutedWithCredit.summary.estimatedNetPayoutCents,
        ).toBeGreaterThan(parseUsdToCents(data.summary.estimatedNetPayoutUsd)!);
      }

      if (preset.id === "delver-lens-postage-guard") {
        expect(data.summary.outboundBoxCount).toBe(0);
        expect(
          data.summary.vendorShipments.some(
            (v: { demotedToNonBuylist: boolean; totalCards: number }) =>
              v.demotedToNonBuylist && v.totalCards === 4,
          ),
        ).toBe(true);
      }
    }
  });

  it("enforces <=500-card split batch previews/downloads and blocks invalid Curated/Sorted Card Conduit downloads (H1)", async () => {
    const { db } = await getReadyDb();
    const allCards = await db.select().from(cardCatalog);
    const pollutedDelta = allCards.find((c) => c.name === "Polluted Delta")!;
    const cultivate = allCards.find((c) => c.name === "Cultivate")!;
    const routed650 = routeCollectionLot({
      purchaseCostUsd: "4000.00",
      items: [
        {
          card: pollutedDelta,
          finish: "normal",
          condition: "NM",
          quantity: 650,
        },
      ],
      profile: { conduitTierPreference: "sorted" },
      options: { buylistCashMode: "conduit" },
    });

    const bundle = generateAllLotExports(routed650.items, {
      conduitTier: "sorted",
      strictConduitValidation: false,
    });
    expect(bundle.cardConduit.batches).toHaveLength(2);
    expect(bundle.cardConduit.batches[0]!.totalCards).toBe(500);
    expect(bundle.cardConduit.batches[1]!.totalCards).toBe(150);

    // Batch #1 preview & primary download must contain ONLY 500 cards (never unsplit 650-card combined CSV)
    const viewBatch1 = resolveConduitDrawerView(bundle.cardConduit, 0);
    expect(viewBatch1.downloadDisabled).toBe(false);
    expect(viewBatch1.previewFilename).toBe("card-conduit-sorted-batch-1.csv");
    expect(viewBatch1.previewContent).toContain("500,Polluted Delta");
    expect(viewBatch1.previewContent).not.toContain("650,Polluted Delta");
    expect(viewBatch1.primaryDownloadFiles).toHaveLength(2);
    expect(viewBatch1.primaryDownloadFiles[0]!.csv).toContain(
      "500,Polluted Delta",
    );
    expect(viewBatch1.primaryDownloadFiles[1]!.csv).toContain(
      "150,Polluted Delta",
    );

    const viewBatch2 = resolveConduitDrawerView(bundle.cardConduit, 1);
    expect(viewBatch2.previewFilename).toBe("card-conduit-sorted-batch-2.csv");
    expect(viewBatch2.previewContent).toContain("150,Polluted Delta");

    // Invalid Sorted shipment (contains < $0.50 item) must disable downloads in ExportDrawer
    const invalidBundle = generateAllLotExports(
      [
        {
          card: cultivate,
          finish: "normal",
          condition: "NM",
          language: "en",
          isAltered: false,
          isMisprint: false,
          quantity: 5,
          assignedBucket: "PILE_1_BUYLIST",
          recommendedChannel: "conduit_sorted",
          baselines: {
            pRetailTcgUsd: "0.85",
            pRetailMpUsd: "0.70",
            pRetailP2pUsd: "0.65",
            pSaleP2pClaimUsd: "0.55",
            pBuyCkCents: 25n,
            pBuyConduitCents: 25n,
          },
        },
      ],
      { conduitTier: "sorted", strictConduitValidation: false },
    );
    expect(invalidBundle.cardConduit.validation.valid).toBe(false);
    const invalidView = resolveConduitDrawerView(invalidBundle.cardConduit, 0);
    expect(invalidView.downloadDisabled).toBe(true);
    expect(invalidView.primaryDownloadFiles).toHaveLength(0);
  });

  it("preserves buylistCashMode, per-lot profile isolation, deterministic order, and Day-2 locked Schedule C COGS across reloads (H2)", async () => {
    const { db } = await getReadyDb();
    const t0 = new Date("2026-11-15T05:00:00.000Z");
    const tPlus25h = new Date(t0.getTime() + 25 * 60 * 60 * 1000);
    const manaboxPreset = DEMO_SCANNER_PRESETS[0]!;

    // 1. Save a lot with buylistCashMode="conduit", custom labor=$20/hr, enableCreditArbitrage=false, persistProfile=false
    const createConduitRes = await createLotRoute(
      new Request("http://localhost:3000/api/lots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lotName: "Conduit Sorted Test Lot",
          purchaseCostUsd: "1850.00",
          csvText: manaboxPreset.csvText,
          buylistCashMode: "conduit",
          profile: {
            hourlyLaborRateUsd: "20.00",
            enableCreditArbitrage: false,
            conduitTierPreference: "sorted",
          },
          persistProfile: false,
        }),
      }),
    );
    expect(createConduitRes.status).toBe(201);
    const createdConduit = await createConduitRes.json();
    expect(createdConduit.buylistCashMode).toBe("conduit");
    expect(
      createdConduit.summary.vendorShipments.some(
        (v: { vendor: string; demotedToNonBuylist: boolean }) =>
          v.vendor === "card_conduit" && !v.demotedToNonBuylist,
      ),
    ).toBe(true);

    // Global /api/profile was NOT mutated because persistProfile=false
    const globalBeforePatch = await (await getProfileRoute()).json();
    expect(globalBeforePatch.profile.conduitTierPreference).toBe("curated");

    // 2. Mutate global /api/profile to $55/hr + enableCreditArbitrage=true
    await patchProfileRoute(
      new Request("http://localhost:3000/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hourlyLaborRateUsd: "55.00",
          enableCreditArbitrage: true,
        }),
      }),
    );

    // Reloading the saved Conduit lot restores its own $20/hr, enableCreditArbitrage=false, conduitTier="sorted", and buylistCashMode="conduit"
    const reloadedConduitRes = await getLotByIdRoute(
      new Request(
        `http://localhost:3000/api/lots/${createdConduit.lot.lotId}`,
      ),
      { params: Promise.resolve({ lotId: createdConduit.lot.lotId }) },
    );
    expect(reloadedConduitRes.status).toBe(200);
    const reloadedConduit = await reloadedConduitRes.json();
    expect(reloadedConduit.buylistCashMode).toBe("conduit");
    expect(reloadedConduit.profile.hourlyLaborRateUsd).toBe("20.00");
    expect(reloadedConduit.profile.enableCreditArbitrage).toBe(false);
    expect(reloadedConduit.profile.conduitTierPreference).toBe("sorted");
    expect(reloadedConduit.summary.estimatedNetPayoutUsd).toBe(
      reloadedConduit.lot.estimatedNetPayoutUsd,
    );

    // 3. Day-2 (+25h after 24h SKU cache expiry) reload & slider update must NOT drift IRS Schedule C allocatedCostBasisUsd
    const initialBasisByCard = createdConduit.inputs.map(
      (i: { card: { scryfallId: string }; lockedAllocatedCostBasisUsd: string }) => ({
        id: i.card.scryfallId,
        basis: i.lockedAllocatedCostBasisUsd,
      }),
    );
    expect(initialBasisByCard).toHaveLength(36);

    const day2Loaded = await getPersistedLotById(
      db,
      createdConduit.lot.lotId,
      tPlus25h,
    );
    expect(
      day2Loaded.inputs.map((i) => ({
        id: i.card.scryfallId,
        basis: i.lockedAllocatedCostBasisUsd,
      })),
    ).toEqual(initialBasisByCard);

    // Re-routing on Day 2 with higher labor rate ($42/hr) STILL preserves 100% of acquisition-date Schedule C COGS
    const day2Patched = await updatePersistedLot(db, createdConduit.lot.lotId, {
      profile: { hourlyLaborRateUsd: "42.00" },
      rerouteItems: true,
      persistProfile: false,
      now: tPlus25h,
    });
    expect(
      day2Patched.inputs.map((i) => ({
        id: i.card.scryfallId,
        basis: i.lockedAllocatedCostBasisUsd,
      })),
    ).toEqual(initialBasisByCard);
    expect(day2Patched.lot.allocatedCostBasisSumUsd).toBe("1850.00");

    // Changing purchaseCostUsd itself ($1,850.00 -> $2,100.25) intentionally recomputes Hamilton FMV allocation to $2,100.25
    const costChanged = await updatePersistedLot(db, createdConduit.lot.lotId, {
      purchaseCostUsd: "2100.25",
      now: tPlus25h,
    });
    expect(costChanged.lot.allocatedCostBasisSumUsd).toBe("2100.25");
    expect(costChanged.summary.allocatedCostBasisSumUsd).toBe("2100.25");
  });

  it("validates malformed API payloads with clean 400/413 errors (no 500s or SQL leaks) and persists skuApiQuotaResetAt (H3)", async () => {
    const manaboxPreset = DEMO_SCANNER_PRESETS[0]!;

    // 1. Non-UUID lotId returns 400 with zero SQL leak
    for (const fn of [
      () =>
        getLotByIdRoute(new Request("http://localhost:3000/api/lots/not-a-uuid"), {
          params: Promise.resolve({ lotId: "not-a-uuid" }),
        }),
      () =>
        patchLotRoute(
          new Request("http://localhost:3000/api/lots/not-a-uuid", {
            method: "PATCH",
            body: JSON.stringify({ status: "settled" }),
          }),
          { params: Promise.resolve({ lotId: "not-a-uuid" }) },
        ),
      () =>
        deleteLotRoute(
          new Request("http://localhost:3000/api/lots/not-a-uuid", {
            method: "DELETE",
          }),
          { params: Promise.resolve({ lotId: "not-a-uuid" }) },
        ),
    ]) {
      const res = await fn();
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid UUID");
      expect(body.error.toLowerCase()).not.toContain("select ");
    }

    // 2. Null, array, primitive, or invalid JSON bodies return 400
    for (const rawBody of ["null", "[]", "42", "{bad-json"]) {
      const res = await triagePostRoute(
        new Request("http://localhost:3000/api/triage", {
          method: "POST",
          body: rawBody,
        }),
      );
      expect(res.status).toBe(400);
    }

    // 3. Numeric USD fields and empty "" purchaseCostUsd succeed cleanly
    const numUsdRes = await triagePostRoute(
      new Request("http://localhost:3000/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csvText: DEMO_SCANNER_PRESETS[3]!.csvText,
          purchaseCostUsd: 92,
          profile: { hourlyLaborRateUsd: 25 },
        }),
      }),
    );
    expect(numUsdRes.status).toBe(200);
    const numUsdData = await numUsdRes.json();
    expect(numUsdData.summary.purchaseCostUsd).toBe("92.00");
    expect(numUsdData.profile.hourlyLaborRateUsd).toBe("25.00");

    const emptyCostRes = await triagePostRoute(
      new Request("http://localhost:3000/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csvText: DEMO_SCANNER_PRESETS[3]!.csvText,
          purchaseCostUsd: "",
        }),
      }),
    );
    expect(emptyCostRes.status).toBe(200);
    expect((await emptyCostRes.json()).summary.purchaseCostUsd).toBe("0.00");

    // 4. NUMERIC(10, 2) overflow (>= $100,000,000.00) returns 400 instead of DB 500
    const overflowRes = await createLotRoute(
      new Request("http://localhost:3000/api/lots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lotName: "Overflow Lot",
          purchaseCostUsd: "100000000.00",
          csvText: DEMO_SCANNER_PRESETS[3]!.csvText,
        }),
      }),
    );
    expect(overflowRes.status).toBe(400);

    // 5. Invalid purchaseDate, invalid scanner format, and malformed inputs[] return 400
    expect(() =>
      parseScannerCsv(manaboxPreset.csvText, {
        format: "not_a_scanner" as never,
      }),
    ).toThrow(CsvParseError);

    const badFormatRes = await triagePostRoute(
      new Request("http://localhost:3000/api/triage", {
        method: "POST",
        body: JSON.stringify({
          csvText: manaboxPreset.csvText,
          format: "not_a_scanner",
        }),
      }),
    );
    expect(badFormatRes.status).toBe(400);

    const badDateRes = await createLotRoute(
      new Request("http://localhost:3000/api/lots", {
        method: "POST",
        body: JSON.stringify({
          lotName: "Bad Date",
          purchaseDate: "2026-02-31",
          csvText: DEMO_SCANNER_PRESETS[3]!.csvText,
        }),
      }),
    );
    expect(badDateRes.status).toBe(400);

    const badInputsRes = await createLotRoute(
      new Request("http://localhost:3000/api/lots", {
        method: "POST",
        body: JSON.stringify({
          lotName: "Bad Inputs",
          inputs: [
            {
              card: DEMO_CATALOG_CARDS[0],
              finish: "normal",
              condition: "MINTY",
              quantity: 1,
            },
          ],
        }),
      }),
    );
    expect(badInputsRes.status).toBe(400);

    // Unknown catalog scryfallId returns 400 instead of FK violation 500
    const unknownCardRes = await createLotRoute(
      new Request("http://localhost:3000/api/lots", {
        method: "POST",
        body: JSON.stringify({
          lotName: "Unknown Card",
          inputs: [
            {
              card: {
                ...DEMO_CATALOG_CARDS[0],
                scryfallId: "99999999-9999-4999-8999-999999999999",
              },
              finish: "normal",
              condition: "NM",
              quantity: 1,
            },
          ],
        }),
      }),
    );
    expect(unknownCardRes.status).toBe(400);

    // 6. Oversized > 5 MB CSV returns 413
    const oversizedCsv = `Name,Edition\n${"a".repeat(MAX_CSV_BYTES + 64)}`;
    const oversizedRes = await triagePostRoute(
      new Request("http://localhost:3000/api/triage", {
        method: "POST",
        body: JSON.stringify({ csvText: oversizedCsv }),
      }),
    );
    expect(oversizedRes.status).toBe(413);

    // 7. Invalid vs valid skuApiQuotaResetAt on PATCH /api/profile
    const badResetRes = await patchProfileRoute(
      new Request("http://localhost:3000/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ skuApiQuotaResetAt: "not-a-timestamp" }),
      }),
    );
    expect(badResetRes.status).toBe(400);

    const targetResetIso = "2027-01-01T00:00:00.000Z";
    const goodResetRes = await patchProfileRoute(
      new Request("http://localhost:3000/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ skuApiQuotaResetAt: targetResetIso }),
      }),
    );
    expect(goodResetRes.status).toBe(200);
    const persistedProf = await (await getProfileRoute()).json();
    expect(persistedProf.profile.skuApiQuotaResetAt).toBe(targetResetIso);
  });

  it("decrements remaining monthly SKU API quota across resolved rows during CSV ingestion (M4)", async () => {
    const { db } = await getReadyDb();
    const res = await ingestAndRouteScannerCsv(db, {
      csvText: DEMO_SCANNER_PRESETS[0]!.csvText,
      purchaseCostUsd: "1850.00",
      profile: {
        monthlySkuApiQuota: 10,
        monthlySkuApiUsed: 9,
      },
    });

    // Only 1 remaining lookup in quota (10 - 9 = 1); remaining 23 eligible SKUs must report quota_exhausted
    expect(res.diagnostics.proSkuApiEligibleCount).toBe(1);
    expect(res.diagnostics.proSkuApiSkipReasons.quota_exhausted).toBe(23);
  });

  it("persists routed lots, reconciles Schedule C COGS cent-for-cent, updates settlement status/payout, and deletes cleanly", async () => {
    const manaboxPreset = DEMO_SCANNER_PRESETS[0]!;

    const createRes = await createLotRoute(
      new Request("http://localhost:3000/api/lots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lotName: "Sunday Regional Booth Buyout",
          purchaseCostUsd: "1850.37",
          status: "triaged",
          csvText: manaboxPreset.csvText,
          profile: {
            hourlyLaborRateUsd: "24.00",
            enableCreditArbitrage: true,
          },
          persistProfile: true,
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.lot.lotName).toBe("Sunday Regional Booth Buyout");
    expect(created.lot.purchaseCostUsd).toBe("1850.37");
    expect(created.lot.allocatedCostBasisSumUsd).toBe("1850.37");
    expect(created.lot.bucketCardCounts.PILE_3_CREDIT_ARB).toBeGreaterThan(0);

    const lotId = created.lot.lotId as string;

    const listRes = await listLotsRoute();
    const listJson = await listRes.json();
    expect(listJson.lots).toHaveLength(1);
    expect(listJson.lots[0].lotId).toBe(lotId);

    const detailRes = await getLotByIdRoute(
      new Request(`http://localhost:3000/api/lots/${lotId}`),
      { params: Promise.resolve({ lotId }) },
    );
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    expect(detailJson.inputs.length).toBe(36);

    // Invalid negative realized payout returns 400 (M3 backend validation)
    const badSettlementRes = await patchLotRoute(
      new Request(`http://localhost:3000/api/lots/${lotId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "settled",
          actualRealizedPayoutUsd: "-50.00",
        }),
      }),
      { params: Promise.resolve({ lotId }) },
    );
    expect(badSettlementRes.status).toBe(400);

    const patchLotRes = await patchLotRoute(
      new Request(`http://localhost:3000/api/lots/${lotId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "partially_settled",
          actualRealizedPayoutUsd: "2695.80",
        }),
      }),
      { params: Promise.resolve({ lotId }) },
    );
    expect(patchLotRes.status).toBe(200);
    const patchedJson = await patchLotRes.json();
    expect(patchedJson.lot.status).toBe("partially_settled");
    expect(patchedJson.lot.actualRealizedPayoutUsd).toBe("2695.80");
    expect(patchedJson.lot.realizedProfitUsd).toBe("845.43");

    const deleteRes = await deleteLotRoute(
      new Request(`http://localhost:3000/api/lots/${lotId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ lotId }) },
    );
    expect(deleteRes.status).toBe(200);

    const listAfterDelete = await (await listLotsRoute()).json();
    expect(listAfterDelete.lots).toHaveLength(0);
  });
});
