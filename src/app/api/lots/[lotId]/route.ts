import { NextResponse } from "next/server";
import { getReadyDb } from "@/db";
import {
  deletePersistedLot,
  getPersistedLotById,
  parseJsonObjectBody,
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
    console.error("[fliprouter:api/lots/[lotId] GET]", err);
    return NextResponse.json(
      { error: "Failed to fetch lot details." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { lotId } = await context.params;
    const body = await parseJsonObjectBody(request);
    const { db } = await getReadyDb();

    const updated = await updatePersistedLot(db, lotId, {
      lotName: body.lotName,
      purchaseCostUsd: body.purchaseCostUsd,
      status: body.status,
      actualRealizedPayoutUsd: body.actualRealizedPayoutUsd,
      profile: body.profile as Record<string, unknown> | undefined,
      buylistCashMode: body.buylistCashMode,
      persistProfile: body.persistProfile,
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
    console.error("[fliprouter:api/lots/[lotId] PATCH]", err);
    return NextResponse.json(
      { error: "Failed to update lot." },
      { status: 500 },
    );
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
    console.error("[fliprouter:api/lots/[lotId] DELETE]", err);
    return NextResponse.json(
      { error: "Failed to delete lot." },
      { status: 500 },
    );
  }
}
