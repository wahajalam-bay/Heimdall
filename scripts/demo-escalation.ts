/**
 * Shows both escalation ladders working on real rows.
 *
 *   npx tsx scripts/demo-escalation.ts
 *
 * There are two, and they are deliberately different mechanisms feeding one:
 *
 *   · An **approval** past its SLA tells the approver's line manager, counts it
 *     on the step, and raises a tracked APPROVAL_DELAY exception. It does not
 *     move the approval — delegation is the sanctioned way to hand a decision
 *     over, and letting a missed deadline transfer authority would turn every
 *     SLA breach into a route around the approver.
 *
 *   · An **exception** nobody has acknowledged climbs the organogram's own
 *     reporting line, one level per sweep, up to a ceiling.
 *
 * So a stalled approval becomes an exception, and the exception then climbs. One
 * ladder, entered from two places.
 *
 * This ages a pending approval past its deadline so the sweep has something real
 * to find, and reports what actually happened rather than asserting it.
 *
 * Everything it changes, it changes back. Ageing a row is how the sweep is given
 * something to see; *leaving* it aged would put a false deadline on a live
 * document and make it look overdue in every report that reads one. The restore
 * runs in a `finally`, so a failure part-way through does not strand the debris
 * either.
 */
import { writeSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { sessionFor } from "./lib/actors";
import { escalateOverdueApprovals, escalateOverdueExceptions } from "../src/server/controls";

const say = (l = "") => {
  try {
    writeSync(1, `${l}\n`);
  } catch {
    console.log(l);
  }
};

async function actorWith(code: string) {
  const held = await prisma.user.findFirst({
    where: { active: true, roles: { some: { role: { permissions: { some: { permission: { code } } } } } } },
    select: { email: true },
    orderBy: { email: "asc" },
  });
  if (!held) throw new Error(`No active user holds ${code}.`);
  return sessionFor(held.email);
}

/** What this run altered, so it can be put back exactly. */
const undo: Array<() => Promise<unknown>> = [];

async function main() {
  say("\nEscalation — both ladders, on real rows\n");

  const auditor = await actorWith(P.EXCEPTION_MANAGE);
  say(`  Sweeping as ${auditor.name}.`);

  /* ── 1 · An approval past its SLA ─────────────────────── */
  say("\n01. An approval nobody touched");

  const step = await prisma.approvalAction.findFirst({
    where: { action: "PENDING", instance: { status: "PENDING" } },
    orderBy: { assignedAt: "asc" },
    include: {
      instance: { select: { documentType: true, documentRef: true, currentSequence: true } },
    },
  });

  if (!step) {
    say("    No approval is pending anywhere, so there is nothing to age. Nothing to show here.");
  } else {
    const onTheStep = step.sequence === step.instance.currentSequence;
    say(
      `    ${step.instance.documentType} ${step.instance.documentRef} — step ${step.sequence} "${step.stepName}"` +
        `${onTheStep ? "" : " (not the step being waited on, so the sweep should skip it)"}`,
    );
    say(
      `    Assigned ${step.assignedAt.toISOString().slice(0, 10)}, due ${step.dueAt?.toISOString().slice(0, 10) ?? "never"}, ` +
        `escalation level ${step.escalationLevel}.`,
    );

    // Age it four days past its deadline. The sweep's own grace period is a day,
    // and a demonstration that skipped the grace would not be testing the rule.
    const stepId = step.id;
    const originalDueAt = step.dueAt;
    const originalLevel = step.escalationLevel;
    const originalEscalatedTo = step.escalatedToId;
    const originalEscalatedAt = step.escalatedAt;
    undo.push(() =>
      prisma.approvalAction.update({
        where: { id: stepId },
        data: {
          dueAt: originalDueAt,
          escalationLevel: originalLevel,
          escalatedToId: originalEscalatedTo,
          escalatedAt: originalEscalatedAt,
        },
      }),
    );
    await prisma.approvalAction.update({
      where: { id: step.id },
      data: { dueAt: new Date(Date.now() - 4 * 86_400_000) },
    });
    say("    Aged four days past its deadline, which clears the sweep's one-day grace.");

    const swept = await escalateOverdueApprovals(auditor, {}, prisma);
    say(
      `    Sweep: ${swept.escalated} step(s) escalated · ${swept.raised} exception(s) raised · ` +
        `${swept.stuck} with nobody above the approver · ${swept.notified} manager(s) told`,
    );

    const after = await prisma.approvalAction.findUniqueOrThrow({
      where: { id: step.id },
      include: { escalatedTo: { select: { name: true, title: true } } },
    });
    say(
      `    The step now: level ${step.escalationLevel} → ${after.escalationLevel}, ` +
        `told ${after.escalatedTo?.name ?? "nobody"}${after.escalatedTo?.title ? ` (${after.escalatedTo.title})` : ""}.`,
    );
    // The point of the design, checked rather than asserted.
    say(
      `    The approval itself: ${after.action}, still assigned to ${after.assignedRoleCode ?? "the same person"} — ` +
        `${after.action === "PENDING" ? "unmoved, which is the whole point" : "MOVED, which would be wrong"}.`,
    );

    const raised = await prisma.exception.findFirst({
      where: { type: "APPROVAL_DELAY", documentRef: step.instance.documentRef },
      orderBy: { createdAt: "desc" },
      include: { owner: { select: { name: true } } },
    });
    if (raised) {
      say(
        `    Tracked as ${raised.number} · ${raised.severity} · owner ${raised.owner?.name ?? "unassigned"} · ` +
          `due ${raised.dueAt?.toISOString().slice(0, 10) ?? "—"}`,
      );
      say(`      "${raised.title}"`);
    }
  }

  /* ── 2 · An exception climbing the organogram ─────────── */
  say("\n02. An exception nobody acknowledged");

  const open = await prisma.exception.findMany({
    where: { status: { in: ["OPEN", "IN_PROGRESS"] }, acknowledgedAt: null },
    orderBy: { createdAt: "asc" },
    take: 3,
    include: {
      owner: { select: { name: true, reportsToId: true } },
      escalatedTo: { select: { name: true } },
    },
  });

  if (open.length === 0) {
    say("    Nothing open and unacknowledged. Nothing to climb.");
  } else {
    for (const ex of open) {
      say(
        `    ${ex.number} · ${ex.type} · owner ${ex.owner?.name ?? "unassigned"} · ` +
          `level ${ex.escalationLevel}${ex.escalatedTo ? ` (with ${ex.escalatedTo.name})` : ""} · ` +
          `due ${ex.dueAt?.toISOString().slice(0, 10) ?? "no date"}`,
      );
      if (ex.owner && !ex.owner.reportsToId) {
        say("      — this owner reports to nobody, so the sweep will report it stuck rather than pretend it moved");
      }
    }

    // Age them so the sweep sees them, then climb.
    for (const ex of open) {
      const { id, dueAt, escalationLevel, escalatedToId, escalatedAt, escalationNote } = ex;
      undo.push(() =>
        prisma.exception.update({
          where: { id },
          data: { dueAt, escalationLevel, escalatedToId, escalatedAt, escalationNote },
        }),
      );
    }
    await prisma.exception.updateMany({
      where: { id: { in: open.map((e) => e.id) } },
      data: { dueAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    const swept = await escalateOverdueExceptions(auditor, {}, prisma);
    say(
      `    Sweep: ${swept.escalated} pushed up the line · ${swept.stuck} with nobody above them · ${swept.notified} told`,
    );

    for (const ex of open) {
      const after = await prisma.exception.findUniqueOrThrow({
        where: { id: ex.id },
        include: { escalatedTo: { select: { name: true, title: true } } },
      });
      say(
        `    ${after.number}: level ${ex.escalationLevel} → ${after.escalationLevel}` +
          (after.escalatedTo ? ` · now with ${after.escalatedTo.name}` : " · nobody above the owner") +
          (after.escalationNote ? `\n      "${after.escalationNote}"` : ""),
      );
    }
  }

  say("\n  Both sweeps run from scripts/rollups.ts, approvals first — a stalled approval");
  say("  raises an exception, and running the exception sweep afterwards means that new");
  say("  exception does not wait a whole cycle before anybody above the manager hears.\n");
}

main()
  .catch((e) => {
    say(`\nFailed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // In a `finally`, and in reverse, so a run that failed half way through still
    // puts back what it had already changed.
    let restored = 0;
    for (const step of undo.reverse()) {
      try {
        await step();
        restored += 1;
      } catch (e) {
        say(`  (restore failed: ${e instanceof Error ? e.message.slice(0, 90) : e})`);
      }
    }
    if (restored) say(`  ${restored} row(s) put back as they were.`);
    await prisma.$disconnect();
  });
