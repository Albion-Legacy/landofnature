import { NextResponse } from "next/server";
import { albionAuthorized } from "@/lib/albion/auth";
import { MANIFEST } from "@/lib/albion/actions";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!albionAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ app: "landofnature", account: { name: "Land of Nature" }, actions: MANIFEST });
}
