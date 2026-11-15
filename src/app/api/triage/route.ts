import { NextResponse } from "next/server";
import { getReadyDb } from "@/db";
import { CsvParseError } from "@/lib/csv";
import {
  ingestAndRouteScannerCsv,
  parseJsonObjectBody,
  TriageValidationError,
} from "@/lib/triage";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await parseJsonObjectBody(request);
    const { db } = await getReadyDb();

    const response = await ingestAndRouteScannerCsv(db, {
      csvText: body.csvText,
      format: body.format,
      purchaseCostUsd: body.purchaseCostUsd,
      profile: body.profile as Record<string, unknown> | undefined,
      buylistCashMode: body.buylistCashMode,
    });

    return NextResponse.json(response);
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
    console.error("[fliprouter:api/triage POST]", err);
    return NextResponse.json(
      { error: "Failed to ingest scanner CSV." },
      { status: 500 },
    );
  }
}
