/**
 * Pre-qualification validity, preview and expiry warnings — meeting req. 20.
 *
 *   npx tsx scripts/verify-pq-validity.ts
 */
import { prisma } from "../src/lib/db";
import { CONFIG_KEYS } from "../src/lib/config";
import { systemActor } from "../src/lib/actor";
import { refused } from "./lib/actors";
import { pqStanding, pqPreview, warnExpiringPrequalifications } from "../src/server/prequalification";
import { checkVendorEligibility } from "../src/server/sourcing";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const entity = await prisma.entity.findFirstOrThrow({ where: { code: "ZM" } });

  const created: string[] = [];
  const mk = async (name: string, approvedAt: Date | null) => {
    const v = await prisma.vendor.create({
      data: {
        code: `PQT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        name,
        status: "APPROVED",
        approvedAt,
        entityLinks: { create: [{ entityId: entity.id, approved: true }] },
      },
    });
    created.push(v.id);
    return v;
  };

  const months = (n: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    return d;
  };

  const old = await mk("PQ test — approved 40 months ago", months(40));
  const soon = await mk("PQ test — approved 23 months ago", months(23));
  const fresh = await mk("PQ test — approved 2 months ago", months(2));
  const undated = await mk("PQ test — no approval date", null);

  /* ── With no validity in force ── */
  await prisma.configSetting.deleteMany({
    where: { key: CONFIG_KEYS.POLICY_PQ_VALIDITY_MONTHS, entityId: entity.id },
  });

  const off = await pqStanding({ entityId: entity.id });
  check("with no validity in force, nothing is tracked", off.validityMonths === 0);
  const offRows = off.rows.filter((r) => created.includes(r.vendorId));
  check(
    "and every vendor reads as not tracked rather than valid",
    offRows.length === 4 && offRows.every((r) => r.state === "NOT_TRACKED"),
    offRows.map((r) => r.state).join(","),
  );

  const eligibleNow = await checkVendorEligibility(old.id, entity.id);
  check("a 40-month-old approval is still eligible while the control is off", eligibleNow.eligible);

  /* ── The preview, before anything is switched on ── */
  const preview = await pqPreview(entity.id, 24);
  check("the preview reports the current setting", preview.currentMonths === 0);
  check(
    "and names what a 24-month validity would immediately expire",
    preview.wouldExpire.some((w) => w.code === old.code),
    `${preview.expiredImmediately} would expire`,
  );
  check(
    "the 23-month vendor is expiring, not expired",
    !preview.wouldExpire.some((w) => w.code === soon.code) && preview.expiringWithin90 >= 1,
  );
  check("the 2-month vendor stays valid", preview.stillValid >= 1);
  check("a vendor with no approval date is reported as unplaceable", preview.undatable >= 1);
  check(
    "the overdue figure is real, not a flag",
    (preview.wouldExpire.find((w) => w.code === old.code)?.overdueDays ?? 0) > 400,
    `${preview.wouldExpire.find((w) => w.code === old.code)?.overdueDays}d`,
  );

  const preview12 = await pqPreview(entity.id, 12);
  check(
    "a shorter validity expires more, and the preview shows it",
    preview12.expiredImmediately >= preview.expiredImmediately,
    `12mo: ${preview12.expiredImmediately} vs 24mo: ${preview.expiredImmediately}`,
  );

  const previewOff = await pqPreview(entity.id, 0);
  check("zero months expires nothing", previewOff.expiredImmediately === 0);

  /* ── Switch it on for this entity and check the standing agrees ── */
  await prisma.configSetting.create({
    data: {
      key: CONFIG_KEYS.POLICY_PQ_VALIDITY_MONTHS,
      entityId: entity.id,
      value: "24",
      valueType: "number",
      label: "Pre-qualification validity (months)",
      group: "Policy · Vendors",
    },
  });

  const on = await pqStanding({ entityId: entity.id });
  const byId = new Map(on.rows.map((r) => [r.vendorId, r]));
  check("the validity is picked up", on.validityMonths === 24);
  check("the 40-month vendor is expired", byId.get(old.id)?.state === "EXPIRED", byId.get(old.id)?.state);
  check("the 23-month vendor is expiring", byId.get(soon.id)?.state === "EXPIRING", byId.get(soon.id)?.state);
  check("the 2-month vendor is valid", byId.get(fresh.id)?.state === "VALID");
  check(
    "the undated vendor is neither valid nor expired",
    byId.get(undated.id)?.state === "NO_APPROVAL_DATE",
    byId.get(undated.id)?.state,
  );
  check(
    "the expired vendor has an expiry date and a negative remaining",
    !!byId.get(old.id)?.expiresAt && (byId.get(old.id)?.daysRemaining ?? 0) < 0,
  );
  check("the worst position sorts first", on.rows[0]?.state === "EXPIRED");

  const nowIneligible = await checkVendorEligibility(old.id, entity.id);
  check(
    "and sourcing now refuses it — the preview was telling the truth",
    !nowIneligible.eligible,
    nowIneligible.reason,
  );

  /* ── The warning job ── */
  const noGrant = await refused(warnExpiringPrequalifications(systemActor("MIGRATION"), { entityId: entity.id }));
  check("the warning job needs its grant", !!noGrant, noGrant ?? "");

  const warned = await warnExpiringPrequalifications(systemActor("SCHEDULER"), { entityId: entity.id });
  check("it reports what it found", warned.expired >= 1 && warned.expiring >= 1, JSON.stringify(warned));
  check("and tells somebody", warned.notified > 0, `${warned.notified} notified`);

  await prisma.configSetting.deleteMany({
    where: { key: CONFIG_KEYS.POLICY_PQ_VALIDITY_MONTHS, entityId: entity.id },
  });
  const silent = await warnExpiringPrequalifications(systemActor("SCHEDULER"), { entityId: entity.id });
  check(
    "with the control off it warns about nothing",
    silent.expired === 0 && silent.expiring === 0 && silent.notified === 0,
  );

  // Cleanup.
  await prisma.notification.deleteMany({ where: { type: "GENERAL", linkUrl: "/vendors/prequalification" } });
  await prisma.vendorEntityLink.deleteMany({ where: { vendorId: { in: created } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Vendor", entityId: { in: created } } });
  await prisma.vendor.deleteMany({ where: { id: { in: created } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
