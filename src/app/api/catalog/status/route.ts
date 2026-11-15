import { gt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getReadyDb, seedReadyDbCatalog, skuPriceCache } from "@/db";
import { getCatalogCount } from "@/db/seed-demo";
import { getCatalogSyncSnapshot } from "@/lib/catalog";
import {
  getOrCreateUserRoutingProfile,
  serializeRoutingProfile,
} from "@/lib/triage";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const { db, mode, seededCount } = await getReadyDb();
    const [sync, cacheRows, profile] = await Promise.all([
      getCatalogSyncSnapshot(db),
      db
        .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
        .from(skuPriceCache)
        .where(gt(skuPriceCache.expiresAt, sql`NOW()`)),
      getOrCreateUserRoutingProfile(db),
    ]);
    const freshSkuCacheCount = Number(cacheRows[0]?.count ?? 0);

    return NextResponse.json({
      ok: true,
      dbMode: mode,
      catalogCount: sync.catalogCount,
      isFullCatalog: sync.isFullCatalog,
      lastSyncedAt: sync.lastSyncedAt,
      freshSkuCacheCount,
      autoSeededCount: seededCount,
      sync,
      profile: serializeRoutingProfile(profile),
    });
  } catch (err) {
    console.error("[fliprouter:api/catalog/status GET]", err);
    return NextResponse.json(
      { ok: false, error: "Failed to inspect catalog status." },
      { status: 500 },
    );
  }
}

export async function POST(): Promise<NextResponse> {
  try {
    const { db, mode, seedResult } = await seedReadyDbCatalog();
    const catalogCount = await getCatalogCount(db);
    const sync = await getCatalogSyncSnapshot(db);
    return NextResponse.json({
      ok: true,
      dbMode: mode,
      catalogCount,
      isFullCatalog: sync.isFullCatalog,
      lastSyncedAt: sync.lastSyncedAt,
      sync,
      ...seedResult,
    });
  } catch (err) {
    console.error("[fliprouter:api/catalog/status POST]", err);
    return NextResponse.json(
      { ok: false, error: "Failed to seed demo catalog." },
      { status: 500 },
    );
  }
}
