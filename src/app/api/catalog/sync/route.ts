import { NextResponse } from "next/server";
import { getReadyDb } from "@/db";
import {
  type CatalogSyncMode,
  getCatalogSyncSnapshot,
  startCatalogSyncJob,
} from "@/lib/catalog";
import { assertPlainObject, TriageValidationError } from "@/lib/triage";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const { db, mode } = await getReadyDb();
    const sync = await getCatalogSyncSnapshot(db);
    return NextResponse.json({
      ok: true,
      dbMode: mode,
      catalogCount: sync.catalogCount,
      isFullCatalog: sync.isFullCatalog,
      sync,
    });
  } catch (err) {
    console.error("[fliprouter:api/catalog/sync GET]", err);
    return NextResponse.json(
      { ok: false, error: "Failed to read catalog sync status." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    let body: Record<string, unknown> = {};
    const rawText = await request.text();
    if (rawText.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new TriageValidationError("Invalid JSON request body.", 400);
      }
      body = assertPlainObject(parsed, "Request body");
    }

    let syncMode: CatalogSyncMode = "full";
    if (body.mode !== undefined) {
      if (body.mode !== "full" && body.mode !== "prices_only") {
        throw new TriageValidationError(
          'Invalid sync mode. Expected "full" or "prices_only".',
          400,
        );
      }
      syncMode = body.mode;
    }

    let limit: number | undefined;
    if (body.limit !== undefined) {
      if (
        typeof body.limit !== "number" ||
        !Number.isInteger(body.limit) ||
        body.limit < 1 ||
        body.limit > 250_000
      ) {
        throw new TriageValidationError(
          "limit must be an integer between 1 and 250000.",
          400,
        );
      }
      limit = body.limit;
    }

    if (
      body.awaitCompletion !== undefined &&
      typeof body.awaitCompletion !== "boolean"
    ) {
      throw new TriageValidationError(
        "awaitCompletion must be a boolean.",
        400,
      );
    }
    const awaitCompletion = body.awaitCompletion === true;

    const { db, mode: dbMode } = await getReadyDb();
    const launched = await startCatalogSyncJob(db, {
      mode: syncMode,
      syncOptions: limit !== undefined ? { limit } : undefined,
    });

    if (awaitCompletion) {
      await launched.promise;
      const finalSnapshot = await getCatalogSyncSnapshot(db);
      return NextResponse.json({
        ok: true,
        dbMode,
        started: launched.started,
        alreadyRunning: launched.alreadyRunning,
        catalogCount: finalSnapshot.catalogCount,
        isFullCatalog: finalSnapshot.isFullCatalog,
        sync: finalSnapshot,
      });
    }

    return NextResponse.json(
      {
        ok: true,
        dbMode,
        started: launched.started,
        alreadyRunning: launched.alreadyRunning,
        catalogCount: launched.job.catalogCount,
        isFullCatalog: launched.job.isFullCatalog,
        sync: launched.job,
      },
      { status: launched.started ? 202 : 200 },
    );
  } catch (err) {
    if (err instanceof TriageValidationError || err instanceof RangeError) {
      const status =
        err instanceof TriageValidationError ? err.statusCode : 400;
      return NextResponse.json({ ok: false, error: err.message }, { status });
    }
    console.error("[fliprouter:api/catalog/sync POST]", err);
    return NextResponse.json(
      { ok: false, error: "Failed to start catalog sync." },
      { status: 500 },
    );
  }
}
