import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS as P } from "@/lib/permissions";
import { bulkRemindApprovers } from "@/app/(app)/pr/actions";

/** Reads a JSON body without ever letting a malformed one become a 500. */
async function readBody<T>(req: Request): Promise<{ body: T | null; error: string | null }> {
  try {
    const text = await req.text();
    if (!text.trim()) return { body: null, error: "The request had no body." };
    return { body: JSON.parse(text) as T, error: null };
  } catch {
    return { body: null, error: "The request body could not be read as JSON." };
  }
}

/** Bulk approval reminder, used from the requisition register. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!userHasPermission(user, P.PR_VIEW_ALL, P.PR_APPROVE)) {
    return NextResponse.json(
      { ok: false, error: "You do not have permission to chase approvals across the organisation." },
      { status: 403 },
    );
  }
  const { body, error } = await readBody<{ ids?: string[]; reason?: string | null }>(req);
  if (error || !body) return NextResponse.json({ ok: false, error: error ?? "No payload." }, { status: 400 });
  const ids = (body.ids ?? []).filter(Boolean);
  if (!ids.length) return NextResponse.json({ ok: false, error: "No requisitions selected." }, { status: 400 });

  const results = await bulkRemindApprovers(ids, body.reason?.trim() || null);
  const sent = results.filter((r) => r.ok);
  const skipped = results.filter((r) => !r.ok);
  const notified = sent.reduce((a, r) => a + (r.notified ?? 0), 0);

  return NextResponse.json({
    ok: sent.length > 0,
    message: `${sent.length} reminder(s) sent to ${notified} recipient(s).${
      skipped.length ? ` ${skipped.length} skipped.` : ""
    }`,
    error: sent.length === 0 ? skipped.map((s) => s.error).join(" · ") : undefined,
  });
}
