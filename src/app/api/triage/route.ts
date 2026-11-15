import { NextResponse } from "next/server";
import { getReadyDb } from "@/db";
import { CsvParseError, type ScannerFormat } from "@/lib/csv";
import {
  ingestAndRouteScannerCsv,
  type SerializedRoutingProfile,
  TriageValidationError,
} from "@/lib/triage";

export const dynamic = "force-dynamic";

interface TriagePostBody {
  csvText?: string;
  format?: ScannerFormat;
  purchaseCostUsd?: string;
  profile?: Partial<SerializedRoutingProfile>;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as TriagePostBody;
    const { db } = await getReadyDb();

    const response = await ingestAndRouteScannerCsv(db, {
      csvText: body.csvText ?? "",
      format: body.format,
      purchaseCostUsd: body.purchaseCostUsd,
      profile: body.profile,
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
    const message =
      err instanceof Error ? err.message : "Failed to ingest scanner CSV.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
