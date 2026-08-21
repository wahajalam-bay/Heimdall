import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { id?: string; all?: boolean };
  const now = new Date();

  if (body.all) {
    const r = await prisma.notification.updateMany({
      where: { userId: user.id, read: false },
      data: { read: true, readAt: now },
    });
    return NextResponse.json({ ok: true, updated: r.count });
  }
  if (!body.id) return NextResponse.json({ error: "id or all is required" }, { status: 400 });

  // Scope by userId so one user cannot mutate another's notifications.
  const r = await prisma.notification.updateMany({
    where: { id: body.id, userId: user.id },
    data: { read: true, readAt: now },
  });
  return NextResponse.json({ ok: true, updated: r.count });
}
