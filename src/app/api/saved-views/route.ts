import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    resource?: string;
    name?: string;
    config?: string;
    isShared?: boolean;
  };
  if (!body.resource || !body.name) {
    return NextResponse.json({ error: "resource and name are required" }, { status: 400 });
  }
  if ((body.config ?? "").length > 8000) {
    return NextResponse.json({ error: "View configuration is too large." }, { status: 413 });
  }
  const view = await prisma.savedView.upsert({
    where: { userId_resource_name: { userId: user.id, resource: body.resource, name: body.name } },
    create: {
      userId: user.id,
      resource: body.resource,
      name: body.name,
      config: body.config ?? "{}",
      isShared: Boolean(body.isShared),
    },
    update: { config: body.config ?? "{}", isShared: Boolean(body.isShared) },
  });
  return NextResponse.json({ ok: true, id: view.id });
}

export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  await prisma.savedView.deleteMany({ where: { id, userId: user.id } });
  return NextResponse.json({ ok: true });
}
