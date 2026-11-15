import { NextResponse } from "next/server";
import { type CollectionLotStatus, getReadyDb } from "@/db";
import {
  deletePersistedLot,
  getPersistedLotById,
  type SerializedRoutingProfile,
  TriageValidationError,
  updatePersistedLot,
} from "@/lib/triage";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ lotId: string }>;
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { lotId } = await context.params;
    const { db } = await getReadyDb();
    const detail = await getPersistedLotById(db, lotId);
    return NextResponse.json(detail);
  } catch (err) {
    if (err instanceof TriageValidationError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }
    const message =
      err instanceof Error ? err.message : "Failed to fetch lot details.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface PatchLotBody {
  lotName?: string;
  purchaseCostUsd?: string;
  status?: CollectionLotStatus;
  actualRealizedPayoutUsd?: string | null;
  profile?: Partial<SerializedRoutingProfile>;
  rerouteItems?: boolean;
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { lotId } = await context.params;
    const body = (await request.json()) as PatchLotBody;
    const { db } = await getReadyDb();

    const updated = await updatePersistedLot(db, lotId, {
      lotName: body.lotName,
      purchaseCostUsd: body.purchaseCostUsd,
      status: body.status,
      actualRealizedPayoutUsd: body.actualRealizedPayoutUsd,
      profile: body.profile,
      rerouteItems: body.rerouteItems,
    });

    return NextResponse.json(updated);
  } catch (err) {
    if (
      err instanceof TriageValidationError ||
      err instanceof SyntaxError ||
      err instanceof RangeError
    ) {
      const status =
        err instanceof TriageValidationError ? err.statusCode : 400;
      return NextResponse.json({ error: err.message }, { status });
    }
    const message =
      err instanceof Error ? err.message : "Failed to update lot.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { lotId } = await context.params;
    const { db } = await getReadyDb();
    const result = await deletePersistedLot(db, lotId);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TriageValidationError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }
    const message =
      err instanceof Error ? err.message : "Failed to delete lot.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
