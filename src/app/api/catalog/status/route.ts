import { gt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getReadyDb, skuPriceCache } from "@/db";
import { getCatalogCount, seedDemoCatalog } from "@/db/seed-demo";
import {
  getOrCreateUserRoutingProfile,
  serializeRoutingProfile,
} from "@/lib/triage";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const { db, mode, seededCount } = await getReadyDb();
    const catalogCount = await getCatalogCount(db);
    const cacheRows = await db
      .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(skuPriceCache)
      .where(gt(skuPriceCache.expiresAt, sql`NOW()`));
    const freshSkuCacheCount = Number(cacheRows[0]?.count ?? 0);
    const profile = await getOrCreateUserRoutingProfile(db);

    return NextResponse.json({
      ok: true,
      dbMode: mode,
      catalogCount,
      freshSkuCacheCount,
      autoSeededCount: seededCount,
      profile: serializeRoutingProfile(profile),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to inspect catalog status.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(): Promise<NextResponse> {
  try {
    const { db, mode } = await getReadyDb({ autoSeed: false });
    const seedResult = await seedDemoCatalog(db);
    const catalogCount = await getCatalogCount(db);
    return NextResponse.json({
      ok: true,
      dbMode: mode,
      catalogCount,
      ...seedResult,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to seed demo catalog.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
