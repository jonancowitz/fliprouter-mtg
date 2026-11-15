import { NextResponse } from "next/server";
import { type CollectionLotStatus, getReadyDb } from "@/db";
import { CsvParseError } from "@/lib/csv";
import {
  createPersistedLot,
  listPersistedLots,
  type SerializedRoutingCardInput,
  type SerializedRoutingProfile,
  TriageValidationError,
} from "@/lib/triage";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const { db } = await getReadyDb();
    const lots = await listPersistedLots(db);
    return NextResponse.json({ lots });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch saved lots.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface CreateLotBody {
  lotName?: string;
  purchaseCostUsd?: string;
  purchaseDate?: string;
  status?: CollectionLotStatus;
  actualRealizedPayoutUsd?: string | null;
  csvText?: string;
  inputs?: SerializedRoutingCardInput[];
  profile?: Partial<SerializedRoutingProfile>;
  persistProfile?: boolean;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as CreateLotBody;
    const { db } = await getReadyDb();

    const created = await createPersistedLot(db, {
      lotName: body.lotName ?? "",
      purchaseCostUsd: body.purchaseCostUsd ?? "0.00",
      purchaseDate: body.purchaseDate,
      status: body.status,
      actualRealizedPayoutUsd: body.actualRealizedPayoutUsd,
      csvText: body.csvText,
      inputs: body.inputs,
      profile: body.profile,
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
    const message =
      err instanceof Error ? err.message : "Failed to save collection lot.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
