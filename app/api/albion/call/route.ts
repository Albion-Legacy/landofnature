import { NextResponse } from "next/server";
import { albionAuthorized } from "@/lib/albion/auth";
import { runAction } from "@/lib/albion/actions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  if (!albionAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { action, params } = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await runAction(String(action || ""), params ?? {}));
  } catch (e) {
    console.error("[albion/call]", action, e);
    return NextResponse.json({ ok: false, error: "Error interno consultando Land of Nature." }, { status: 500 });
  }
}
