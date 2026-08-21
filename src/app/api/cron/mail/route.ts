import { NextResponse } from "next/server";
import { flushOutbox, outboxSummary } from "@/lib/mail";

/**
 * Sends whatever is queued in the email outbox.
 *
 * Called by the platform scheduler, so it authenticates with a shared secret
 * rather than a session: Vercel sends `Authorization: Bearer $CRON_SECRET`. With
 * no secret configured the endpoint refuses outright rather than sitting open.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured, so scheduled sending is disabled." },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const result = await flushOutbox(200);
  const summary = await outboxSummary();
  return NextResponse.json({ ok: true, ...result, remaining: summary.queued });
}
