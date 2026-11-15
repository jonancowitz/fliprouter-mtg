import { NextResponse } from "next/server";
import { getReadyDb } from "@/db";
import { CsvParseError } from "@/lib/csv";
import {
  createPersistedLot,
  listPersistedLots,
  parseJsonObjectBody,
  TriageValidationError,
} from "@/lib/triage";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const { db } = await getReadyDb();
    const lots = await listPersistedLots(db);
    return NextResponse.json({ lots });
  } catch (err) {
    console.error("[fliprouter:api/lots GET]", err);
    return NextResponse.json(
      { error: "Failed to fetch saved lots." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await parseJsonObjectBody(request);
    const { db } = await getReadyDb();

    const created = await createPersistedLot(db, {
      lotName: body.lotName,
      purchaseCostUsd: body.purchaseCostUsd,
      purchaseDate: body.purchaseDate,
      status: body.status,
      actualRealizedPayoutUsd: body.actualRealizedPayoutUsd,
      csvText: body.csvText,
      inputs: body.inputs,
      profile: body.profile as Record<string, unknown> | undefined,
      buylistCashMode: body.buylistCashMode,
      persistProfile: body.persistProfile,
    });

    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (
      err instanceof TriageValidationError ||
      err instanceof CsvParseError ||
      err instanceof SyntaxError ||
      err instanceof RangeError
    ) {
      const status =
        err instanceof TriageValidationError ? err.statusCode : 400;
      return NextResponse.json({ error: err.message }, { status });
    }
    console.error("[fliprouter:api/lots POST]", err);
    return NextResponse.json(
      { error: "Failed to save collection lot." },
      { status: 500 },
    );
  }
}
