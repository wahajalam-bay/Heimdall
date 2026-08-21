import { NextResponse } from "next/server";
import { destroySession, getSessionUser, requestContext } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

export async function POST() {
  const user = await getSessionUser();
  const { ip, userAgent } = await requestContext();
  if (user) {
    await writeAudit({
      entityType: "User",
      entityId: user.id,
      entityRef: user.email,
      action: "LOGOUT",
      actor: user,
      ip,
      userAgent,
    });
  }
  await destroySession();
  return NextResponse.json({ ok: true });
}
