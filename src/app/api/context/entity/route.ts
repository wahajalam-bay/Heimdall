import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { canAccessEntity, getSessionUser } from "@/lib/auth";
import { ENTITY_COOKIE } from "@/lib/context";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { entityId?: string };
  const value = body.entityId ?? "";
  if (value !== "__all" && !canAccessEntity(user, value)) {
    return NextResponse.json({ error: "You do not have access to that entity." }, { status: 403 });
  }
  const jar = await cookies();
  jar.set(ENTITY_COOKIE, value, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 90 });
  return NextResponse.json({ ok: true });
}
