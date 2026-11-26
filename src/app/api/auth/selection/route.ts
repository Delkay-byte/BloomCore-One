import { NextResponse } from "next/server";
import { getSelectionUser } from "@/lib/auth";

/** Returns the pending dual-role workspace selection for this browser. */
export async function GET() {
  const selection = await getSelectionUser();
  if (!selection) {
    return NextResponse.json({ error: "No pending workspace selection" }, { status: 401 });
  }
  return NextResponse.json(selection, {
    headers: { "Cache-Control": "no-store" },
  });
}
