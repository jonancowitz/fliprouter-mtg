import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getReadyDb } from "@/db";
import { cardCatalog } from "@/db/schema";
import { DEMO_CATALOG_CARDS } from "@/db/demo-cards";
import { FULL_CATALOG_MIN_THRESHOLD } from "@/lib/catalog";
import {
  detectScannerFormat,
  parseScannerCsv,
  resolveParsedCsvRows,
} from "@/lib/csv";
import { buildDemoCatalogGuidance, ingestAndRouteScannerCsv } from "@/lib/triage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sampleCsvPath = path.join(
  __dirname,
  "../fixtures/manabox-whole-collection-sample.csv",
);

/** Real ManaBox Whole Collection UUIDs from Jon's export (not in demo seed). */
const FILIGREE_ANGEL_ID = "afee5684-e9ff-4451-b3e9-184c2e83fb36";
const OMNATH_ID = "58f311e7-7ebf-4428-b5a3-154255eb3ba1";

describe("ManaBox Whole Collection CSV regression", () => {
  const sampleCsv = fs.readFileSync(sampleCsvPath, "utf8");
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

  it("detects manabox and extracts every Scryfall ID from Jon's sample export", () => {
    const parsed = parseScannerCsv(sampleCsv);
    expect(detectScannerFormat(parsed.headers)).toBe("manabox");
    expect(parsed.format).toBe("manabox");
    expect(parsed.rows.length).toBeGreaterThanOrEqual(20);
    expect(parsed.rows.every((r) => r.scryfallId !== null)).toBe(true);
    expect(parsed.rows[0]).toMatchObject({
      cardName: "Filigree Angel",
      scryfallId: FILIGREE_ANGEL_ID,
      setCode: "c16",
      collectorNumber: "199",
      finish: "normal",
      condition: "NM",
    });
    expect(parsed.rows[1]).toMatchObject({
      cardName: "Omnath, Locus of Rage",
      scryfallId: OMNATH_ID,
      setCode: "bfz",
      collectorNumber: "217",
    });
  });

  it("resolves 0 rows against demo seed and emits Sync Full Catalog guidance", async () => {
    const { db } = await getReadyDb();

    const parsed = parseScannerCsv(sampleCsv);
    const first20 = parsed.rows.slice(0, 20);
    const resolution = await resolveParsedCsvRows(first20, db);
    expect(resolution.resolved.length).toBe(0);
    expect(
      resolution.unresolved.every((u) => u.reason === "catalog_not_found"),
    ).toBe(true);

    const ingested = await ingestAndRouteScannerCsv(db, {
      csvText: sampleCsv,
      purchaseCostUsd: "0.00",
    });
    expect(ingested.diagnostics.isFullCatalog).toBe(false);
    expect(ingested.diagnostics.catalogCount).toBe(DEMO_CATALOG_CARDS.length);
    expect(ingested.diagnostics.catalogNotFoundCount).toBe(
      ingested.diagnostics.totalParsedRows,
    );
    expect(ingested.diagnostics.totalResolvedRows).toBe(0);
    expect(ingested.diagnostics.catalogGuidance).toMatch(
      /Sync Full 100k\+ Catalog/i,
    );
    expect(ingested.diagnostics.catalogGuidance).toContain(
      FULL_CATALOG_MIN_THRESHOLD.toLocaleString("en-US"),
    );

    expect(
      buildDemoCatalogGuidance({
        catalogCount: DEMO_CATALOG_CARDS.length,
        isFullCatalog: false,
        totalParsedRows: 20,
        resolvedRows: 0,
        catalogNotFoundCount: 20,
      }),
    ).toMatch(/demo printings/i);
  });

  it("resolves first ~20 rows after seeding those exact Scryfall IDs", async () => {
    const { db } = await getReadyDb({ autoSeed: false });
    const parsed = parseScannerCsv(sampleCsv);
    const first20 = parsed.rows.slice(0, 20);

    for (const row of first20) {
      await db.insert(cardCatalog).values({
        scryfallId: row.scryfallId!,
        oracleId: "00000000-0000-4000-8000-0000000000aa",
        name: row.cardName ?? "Unknown",
        setCode: row.setCode ?? "unk",
        setName: row.setName ?? "Unknown",
        collectorNumber: row.collectorNumber ?? "0",
        rarity: "rare",
        finishes: ["nonfoil", "foil"],
        tcgMarketNm: "1.00",
        tcgLowNm: "0.80",
      });
    }

    const resolution = await resolveParsedCsvRows(first20, db);
    expect(resolution.resolved.length).toBe(20);
    expect(resolution.unresolved.length).toBe(0);
    expect(
      resolution.resolved.every((r) => r.matchedBy === "scryfall_id"),
    ).toBe(true);
    expect(resolution.resolved[0]!.card.scryfallId).toBe(FILIGREE_ANGEL_ID);
    expect(resolution.resolved[1]!.card.scryfallId).toBe(OMNATH_ID);
  });
});
