import { NextResponse } from "next/server";
import { getReadyDb } from "@/db";
import {
  getOrCreateUserRoutingProfile,
  type SerializedRoutingProfile,
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
    const message =
      err instanceof Error ? err.message : "Failed to load routing profile.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as Partial<SerializedRoutingProfile>;
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
    const message =
      err instanceof Error ? err.message : "Failed to update routing profile.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
