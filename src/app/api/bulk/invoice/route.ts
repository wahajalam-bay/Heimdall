import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS as P } from "@/lib/permissions";
import { bulkRematchInvoices } from "@/app/(app)/invoices/actions";

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

/** Bulk re-run of the three-way match, used from the invoice register. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!userHasPermission(user, P.INVOICE_VERIFY)) {
    return NextResponse.json(
      { ok: false, error: "You do not have permission to verify invoices." },
      { status: 403 },
    );
  }
  const { body, error } = await readBody<{ ids?: string[] }>(req);
  if (error || !body) return NextResponse.json({ ok: false, error: error ?? "No payload." }, { status: 400 });
  const ids = (body.ids ?? []).filter(Boolean);
  if (!ids.length) return NextResponse.json({ ok: false, error: "No invoices selected." }, { status: 400 });

  const results = await bulkRematchInvoices(ids);
  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok && r.passed).length;
  const stillFailing = results.filter((r) => r.ok && r.passed === false).length;

  return NextResponse.json({
    ok: failed.length === 0,
    message:
      failed.length === 0
        ? `${results.length} invoice(s) re-matched: ${passed} now pass, ${stillFailing} still fail.`
        : `${results.length - failed.length} re-matched, ${failed.length} could not be read.`,
    error: failed.length ? failed.map((f) => f.error).join(" · ") : undefined,
  });
}
