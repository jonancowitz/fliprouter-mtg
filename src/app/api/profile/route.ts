import { NextResponse } from "next/server";
import { getReadyDb } from "@/db";
import {
  getOrCreateUserRoutingProfile,
  parseJsonObjectBody,
  serializeRoutingProfile,
  TriageValidationError,
  upsertUserRoutingProfile,
} from "@/lib/triage";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const { db } = await getReadyDb();
    const profile = await getOrCreateUserRoutingProfile(db);
    return NextResponse.json({ profile: serializeRoutingProfile(profile) });
  } catch (err) {
    console.error("[fliprouter:api/profile GET]", err);
    return NextResponse.json(
      { error: "Failed to load routing profile." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  try {
    const body = await parseJsonObjectBody(request);
    const { db } = await getReadyDb();
    const updated = await upsertUserRoutingProfile(db, body);
    return NextResponse.json({ profile: serializeRoutingProfile(updated) });
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
    console.error("[fliprouter:api/profile PATCH]", err);
    return NextResponse.json(
      { error: "Failed to update routing profile." },
      { status: 500 },
    );
  }
}
