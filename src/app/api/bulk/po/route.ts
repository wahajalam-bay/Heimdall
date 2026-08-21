import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS as P } from "@/lib/permissions";
import { bulkClosePos } from "@/app/(app)/po/actions";

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

/** Bulk short-close endpoint used by the Open PO control tower. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!userHasPermission(user, P.PO_CLOSE)) {
    return NextResponse.json({ ok: false, error: "You do not have permission to close purchase orders." }, { status: 403 });
  }
  const { body, error } = await readBody<{ ids?: string[]; reason?: string | null }>(req);
  if (error || !body) return NextResponse.json({ ok: false, error: error ?? "No payload." }, { status: 400 });
  const ids = (body.ids ?? []).filter(Boolean);
  if (!ids.length) return NextResponse.json({ ok: false, error: "No purchase orders selected." }, { status: 400 });
  if (!body.reason || body.reason.trim().length < 8) {
    return NextResponse.json(
      { ok: false, error: "A substantive closure reason is required when short-closing purchase orders." },
      { status: 400 },
    );
  }

  const results = await bulkClosePos(ids, body.reason.trim());
  const failed = results.filter((r) => !r.ok);
  return NextResponse.json({
    ok: failed.length === 0,
    message:
      failed.length === 0
        ? `${results.length} purchase order(s) closed.`
        : `${results.length - failed.length} closed, ${failed.length} refused: ${failed.map((f) => f.error).join(" · ")}`,
    error: failed.length ? failed.map((f) => f.error).join(" · ") : undefined,
  });
}
