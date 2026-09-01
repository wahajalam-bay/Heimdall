/**
 * The Price Competitiveness Policy — ZAM/PUR/SOP-01.
 *
 *   npx tsx scripts/verify-price-competitiveness.ts
 */
import { prisma } from "../src/lib/db";
import { CONFIG_KEYS } from "../src/lib/config";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { withPermissions, withoutPermissions, refused } from "./lib/actors";
import { runVerification } from "./lib/fixtures";
import {
  priceCompetitivenessState,
  recordPriceCompetitiveness,
  classifyEmergency,
  assertPriceCompetitive,
  EMERGENCY_EXCUSES,
} from "../src/server/price-competitiveness";

runVerification("price competitiveness", async (scope) => {
  let pass = 0;
  let fail = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    if (ok) {
      pass++;
      console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
    } else {
      fail++;
      console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };

  const buyer = await withPermissions([P.COMPARATIVE_CREATE]);
  const outsider = await withoutPermissions(P.COMPARATIVE_CREATE, P.NEGOTIATE);
  const approver = await withPermissions([P.EXCEPTION_MANAGE]);
  const noAuthority = await withoutPermissions(
    P.EXCEPTION_MANAGE,
    P.CPC_DECIDE,
    P.INVOICE_EXCEPTION_APPROVE,
  );

  // A comparative that is still open, so the review can be recorded against it.
  const comparative = await prisma.comparative.findFirst({
    where: { status: { in: ["DRAFT", "UNDER_REVIEW", "RECOMMENDED"] } },
    select: { id: true, number: true, pr: { select: { entityId: true } }, _count: { select: { lines: true } } },
    orderBy: { preparedAt: "desc" },
  });
  if (!comparative) throw new Error("no open comparative to test against");

  scope.onCleanup("price competitiveness review", () =>
    prisma.priceCompetitivenessReview.deleteMany({ where: { comparativeId: comparative.id } }),
  );
  scope.onCleanup("audit rows", () =>
    prisma.auditLog.deleteMany({
      where: {
        entityType: "Comparative",
        entityId: comparative.id,
        action: { in: ["PRICE_COMPETITIVENESS_RECORDED", "EMERGENCY_PURCHASE_CLASSIFIED"] },
      },
    }),
  );

  /* ── With nothing recorded ── */
  const blank = await priceCompetitivenessState(comparative.id);
  check(
    "with no review recorded, the policy is not passed by default",
    !blank.complete && blank.blockers.length > 0,
    `${blank.blockers.length} short`,
  );
  check(
    "the imported-item checks do not bite on a local purchase",
    blank.items.find((i) => i.step === "INTERNATIONAL_PRICES")?.applicable === false,
  );
  check(
    "and neither do the new-vendor prerequisites when no new vendor is involved",
    blank.items.find((i) => i.step === "NEW_VENDOR_PREREQUISITES")?.applicable === false,
  );

  /* ── Permission and the single-source rule ── */
  const noPerm = await refused(
    recordPriceCompetitiveness(outsider, { comparativeId: comparative.id }),
  );
  check("recording the review needs permission", !!noPerm, noPerm ?? "");

  const unexplainedSingle = await refused(
    recordPriceCompetitiveness(buyer, { comparativeId: comparative.id, sourcingBasis: "SINGLE" }),
  );
  check("a single-sourced award with no volume rationale is refused", !!unexplainedSingle, unexplainedSingle ?? "");

  const explainedSingle = await recordPriceCompetitiveness(buyer, {
    comparativeId: comparative.id,
    sourcingBasis: "SINGLE",
    volumeRationale: "Annual volume is below the minimum order any second supplier will quote.",
    lastBuyingPriceReviewed: true,
    lastBuyingPrice: 268500,
    lastBuyingPriceSource: "PO-2026-00011",
    localPricesChecked: true,
    localPriceNote: "Two local distributors called; both above.",
    costAnalysisAttached: true,
  });
  check("with the volumes stated, single sourcing is legitimate", explainedSingle.sourcingBasis === "SINGLE");

  const single = await priceCompetitivenessState(comparative.id);
  check(
    "the sourcing-basis step is satisfied once the reasoning exists",
    single.items.find((i) => i.step === "SOURCING_BASIS")?.satisfied === true,
  );
  check(
    "the last buying price carries its source",
    single.items.find((i) => i.step === "LAST_BUYING_PRICE")?.detail?.includes("PO-2026-00011") === true,
    single.items.find((i) => i.step === "LAST_BUYING_PRICE")?.detail ?? "",
  );

  const shortOfQuotes = single.items.find((i) => i.step === "QUOTATION_MINIMUM");
  check(
    "the quotation minimum reports the real count against the requirement",
    !!shortOfQuotes?.detail?.includes("required"),
    shortOfQuotes?.detail ?? "",
  );

  /* ── The imported branch turns the international checks on ── */
  await recordPriceCompetitiveness(buyer, {
    comparativeId: comparative.id,
    imported: true,
    sourcingBasis: "SINGLE",
    volumeRationale: "As above.",
    lastBuyingPriceReviewed: true,
    localPricesChecked: true,
    costAnalysisAttached: true,
  });
  const imported = await priceCompetitivenessState(comparative.id);
  check(
    "marking the goods imported makes the international check apply",
    imported.items.find((i) => i.step === "INTERNATIONAL_PRICES")?.applicable === true,
  );
  check(
    "and it blocks until it is answered",
    imported.items.find((i) => i.step === "INTERNATIONAL_PRICES")?.blocking === true,
  );

  /* ── Emergency relaxes, it does not waive ── */
  const noRight = await refused(
    classifyEmergency(noAuthority, { comparativeId: comparative.id, reason: "Needed urgently for the floor works." }),
  );
  check("classifying an emergency needs exception authority", !!noRight, noRight ?? "");

  const thin = await refused(
    classifyEmergency(approver, { comparativeId: comparative.id, reason: "urgent" }),
  );
  check("a one-word emergency reason is refused", !!thin, thin ?? "");

  await classifyEmergency(approver, {
    comparativeId: comparative.id,
    reason: "Second floor renovation must complete before the tenancy starts; no time for a market study.",
  });
  const emergency = await priceCompetitivenessState(comparative.id);
  check("the emergency is recorded with its approver", emergency.emergency && !!emergency.emergencyApprovedByName);
  check(
    "it excuses the international price study",
    emergency.items.find((i) => i.step === "INTERNATIONAL_PRICES")?.excused === true,
  );
  check(
    "it excuses the local price study and the quotation minimum",
    emergency.items.find((i) => i.step === "LOCAL_PRICES")?.excused !== undefined &&
      emergency.items.find((i) => i.step === "QUOTATION_MINIMUM")?.excused !== undefined,
  );
  check(
    "it excuses exactly the three steps the SOP relaxes, and no more",
    EMERGENCY_EXCUSES.length === 3 &&
      emergency.items.filter((i) => i.excused).every((i) => EMERGENCY_EXCUSES.includes(i.step)),
    emergency.excused.join(", ") || "(nothing was outstanding to excuse)",
  );
  check(
    "it does not excuse the last buying price",
    !EMERGENCY_EXCUSES.includes("LAST_BUYING_PRICE"),
  );
  check("nor the cost analysis", !EMERGENCY_EXCUSES.includes("COST_ANALYSIS"));
  check("nor the sourcing basis", !EMERGENCY_EXCUSES.includes("SOURCING_BASIS"));

  const emergencyAudit = await prisma.auditLog.findFirst({
    where: {
      entityType: "Comparative",
      entityId: comparative.id,
      action: "EMERGENCY_PURCHASE_CLASSIFIED",
    },
  });
  check("the classification is audited with what it excused", !!emergencyAudit);

  /* ── The gate ── */
  const entityId = comparative.pr?.entityId ?? null;
  let unenforced = true;
  try {
    await assertPriceCompetitive(comparative.id, comparative.number, entityId);
  } catch {
    unenforced = false;
  }
  check("the gate is off by default, so nothing in flight is blocked", unenforced);

  await prisma.configSetting.deleteMany({
    where: { key: CONFIG_KEYS.ENFORCE_PRICE_COMPETITIVENESS, entityId },
  });
  await prisma.configSetting.create({
    data: {
      key: CONFIG_KEYS.ENFORCE_PRICE_COMPETITIVENESS,
      entityId,
      value: "1",
      valueType: "number",
      label: "Block a recommendation on an incomplete price competitiveness review",
      group: "Sourcing",
    },
  });
  scope.onCleanup("enforcement flag", () =>
    prisma.configSetting.deleteMany({
      where: { key: CONFIG_KEYS.ENFORCE_PRICE_COMPETITIVENESS, entityId },
    }),
  );

  // Everything the emergency did not excuse is answered, so it should pass now.
  let enforcedPasses = true;
  try {
    await assertPriceCompetitive(comparative.id, comparative.number, entityId);
  } catch {
    enforcedPasses = false;
  }
  check("with the gate on and the emergency granted, the award may proceed", enforcedPasses);

  // Remove the cost analysis — a step the emergency does not excuse.
  await prisma.priceCompetitivenessReview.update({
    where: { comparativeId: comparative.id },
    data: { costAnalysisAttached: false },
  });
  const stillBlocked = await refused(
    assertPriceCompetitive(comparative.id, comparative.number, entityId),
  );
  check(
    "but an emergency does not excuse the cost analysis",
    !!stillBlocked,
    stillBlocked ?? "",
  );

  return { pass, fail };
});
