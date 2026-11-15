import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as getCatalogStatus, POST as reseedCatalog } from "@/app/api/catalog/status/route";
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
import { closeDb, getDbMode, getReadyDb } from "@/db";
import { DEMO_SCANNER_PRESETS } from "@/lib/demo/scanner-presets";
import { hydrateRoutingCardInputs, hydrateRoutingProfile } from "@/lib/triage";
import {
  parseUsdToCents,
  routeCollectionLot,
} from "@/lib/routing";

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

  it("auto-migrates and auto-seeds local PGlite catalog when DATABASE_URL is unset", async () => {
    expect(getDbMode()).toBe("pglite");
    const ready = await getReadyDb();
    expect(ready.mode).toBe("pglite");
    expect(ready.seededCount).toBeGreaterThanOrEqual(40);

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

  it("resolves all 4 scanner CSV presets with 100% catalog match and exercises all 4 piles + Credit Arb + $12 Postage Guard", async () => {
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
        // Default profile: Pile 1, Pile 2, and Pile 4 populated; Pile 3 empty until credit arb toggled
        expect(data.summary.buckets.PILE_1_BUYLIST.totalCards).toBeGreaterThan(0);
        expect(data.summary.buckets.PILE_2_SINGLES.totalCards).toBeGreaterThan(0);
        expect(data.summary.buckets.PILE_3_CREDIT_ARB.totalCards).toBe(0);
        expect(data.summary.buckets.PILE_4_BULK.totalCards).toBeGreaterThan(0);
        expect(data.diagnostics.freshSkuCacheHitCount).toBe(2);

        // Toggle Store Credit Arbitrage synchronously via client math -> Pile 3 lights up!
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
        // Small binder buylist items fail the $12.00 outbound box hurdle and auto-demote!
        expect(data.summary.outboundBoxCount).toBe(0);
        expect(data.summary.vendorShipments.some((v: { demotedToNonBuylist: boolean }) => v.demotedToNonBuylist)).toBe(true);
      }
    }
  });

  it("persists routed lots, reconciles Schedule C COGS cent-for-cent, updates settlement status/payout, and updates profile", async () => {
    const manaboxPreset = DEMO_SCANNER_PRESETS[0]!;

    // Update user default profile via PATCH /api/profile
    const patchProfRes = await patchProfileRoute(
      new Request("http://localhost:3000/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hourlyLaborRateUsd: "24.00",
          enableCreditArbitrage: true,
        }),
      }),
    );
    expect(patchProfRes.status).toBe(200);
    const getProfRes = await getProfileRoute();
    const profJson = await getProfRes.json();
    expect(profJson.profile.hourlyLaborRateUsd).toBe("24.00");
    expect(profJson.profile.enableCreditArbitrage).toBe(true);

    // Create persisted lot with non-divisible purchase cost $1,850.37 to test Hamilton cent reconciliation
    const createRes = await createLotRoute(
      new Request("http://localhost:3000/api/lots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lotName: "Sunday Regional Booth Buyout",
          purchaseCostUsd: "1850.37",
          status: "triaged",
          csvText: manaboxPreset.csvText,
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

    // List lots
    const listRes = await listLotsRoute();
    const listJson = await listRes.json();
    expect(listJson.lots).toHaveLength(1);
    expect(listJson.lots[0].lotId).toBe(lotId);

    // Fetch lot detail
    const detailRes = await getLotByIdRoute(
      new Request(`http://localhost:3000/api/lots/${lotId}`),
      { params: Promise.resolve({ lotId }) },
    );
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    expect(detailJson.inputs.length).toBe(36);

    // Patch status & IRS Schedule C actual realized payout
    const patchLotRes = await patchLotRoute(
      new Request(`http://localhost:3000/api/lots/${lotId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "settled",
          actualRealizedPayoutUsd: "2695.80",
        }),
      }),
      { params: Promise.resolve({ lotId }) },
    );
    expect(patchLotRes.status).toBe(200);
    const patchedJson = await patchLotRes.json();
    expect(patchedJson.lot.status).toBe("settled");
    expect(patchedJson.lot.actualRealizedPayoutUsd).toBe("2695.80");
    expect(patchedJson.lot.realizedProfitUsd).toBe("845.43");

    // Delete lot
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
