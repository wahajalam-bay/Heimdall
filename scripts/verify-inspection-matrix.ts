/**
 * The inspection responsibility matrix — ZAM/PUR/SOP-01 Store Process Flow.
 *
 *   npx tsx scripts/verify-inspection-matrix.ts
 */
import { prisma } from "../src/lib/db";
import { PERMISSIONS as P } from "../src/lib/permissions";
import { withPermissions, withoutPermissions, refused } from "./lib/actors";
import {
  responsibilitiesForCategory,
  createSignoffs,
  signoffsFor,
  signOffInspection,
  assertSignoffsComplete,
  SOP_INSPECTION_MATRIX,
} from "../src/server/inspection-matrix";

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
  const rows = await prisma.inspectionResponsibility.findMany({ where: { entityId: null } });
  check("all twenty-one chart cells are loaded", rows.length === 21, `${rows.length} rows`);
  check(
    "every cell cites the chart it came from",
    rows.every((r) => !!r.sourceReference?.includes("Store – Process Flow")),
  );

  // The chart's three interesting columns.
  const furn = await prisma.category.findFirst({ where: { code: "FURN" } });
  const it = await prisma.category.findFirst({ where: { code: "IT-EQUIP" } });
  const steel = await prisma.category.findFirst({ where: { code: "CONSTR-STEEL" } });
  if (!furn || !it || !steel) throw new Error("expected categories missing");

  const f = await responsibilitiesForCategory(furn.id, null);
  check("furniture resolves to the Furniture column", f.categoryGroup === "Furniture");
  check(
    "furniture: Admin technical, Admin qualitative, Store count",
    f.responsibilities.map((r) => `${r.inspectionType}:${r.ownerFunction}`).join(" ") ===
      "TECHNICAL:ADMIN QUALITATIVE:ADMIN QUANTITATIVE:STORE",
    f.responsibilities.map((r) => `${r.inspectionType}=${r.ownerFunction}`).join(", "),
  );

  const i = await responsibilitiesForCategory(it.id, null);
  check(
    "IT equipment: IT technical and qualitative, Store count",
    i.responsibilities.map((r) => r.ownerFunction).join(",") === "IT,IT,STORE",
    i.responsibilities.map((r) => `${r.inspectionType}=${r.ownerFunction}`).join(", "),
  );

  const st = await responsibilitiesForCategory(steel.id, null);
  check("rebar is not on the chart", st.responsibilities.length === 0 && !!st.unmapped);
  check("and the silence is reported rather than guessed at", !!st.unmapped?.includes("not on the SOP"), st.unmapped ?? "");

  const none = await responsibilitiesForCategory(null, null);
  check("no category at all is also reported, not defaulted", none.responsibilities.length === 0 && !!none.unmapped);

  // Sign-offs on a real inspection.
  const inspector = await withPermissions([P.INSPECTION_PERFORM, P.INSPECTION_SCHEDULE]);
  const plain = await withPermissions([P.INSPECTION_PERFORM]);
  const outsider = await withoutPermissions(P.INSPECTION_PERFORM);

  const insp = await prisma.inspection.create({
    data: { number: `TEST-INSP-${Date.now()}`, inspectionType: "GENERAL", result: "PENDING" },
  });

  const written = await createSignoffs(insp.id, f.responsibilities);
  check("three sign-offs are written for furniture", written === 3);
  const again = await createSignoffs(insp.id, f.responsibilities);
  check("writing them twice does nothing", again === 0);

  const blocked = await refused(assertSignoffsComplete(insp.id, insp.number));
  check("the inspection cannot close while checks are unsigned", !!blocked, blocked ?? "");
  check("and the message names which ones", !!blocked?.includes("technical") && !!blocked?.includes("Admin"));

  let sgs = await signoffsFor(insp.id);
  check("the sign-offs read back in chart order", sgs.map((x) => x.inspectionType).join(",") === "TECHNICAL,QUALITATIVE,QUANTITATIVE");

  const noPerm = await refused(signOffInspection(outsider, { signoffId: sgs[0]!.id, verdict: "PASS" }));
  check("signing needs the inspection permission", !!noPerm);

  const wrongFunction = await refused(
    signOffInspection(plain, { signoffId: sgs[0]!.id, verdict: "PASS" }),
  );
  check(
    "a signer outside the named function is refused",
    !!wrongFunction,
    wrongFunction ?? "(the test actor happened to hold the role)",
  );

  const noNote = await refused(signOffInspection(inspector, { signoffId: sgs[0]!.id, verdict: "FAIL" }));
  check("a failed check must say what was wrong", !!noNote, noNote ?? "");

  await signOffInspection(inspector, { signoffId: sgs[0]!.id, verdict: "PASS" });
  const twice = await refused(signOffInspection(inspector, { signoffId: sgs[0]!.id, verdict: "PASS" }));
  check("a check cannot be signed twice", !!twice, twice ?? "");

  const att = await prisma.attestation.findFirst({
    where: { documentType: "INSPECTION", documentId: insp.id },
  });
  check("the sign-off produces a real attestation", !!att, att?.comment ?? "");

  const stillBlocked = await refused(assertSignoffsComplete(insp.id, insp.number));
  check("one signature is not all concerns", !!stillBlocked, stillBlocked ?? "");

  sgs = await signoffsFor(insp.id);
  await signOffInspection(inspector, { signoffId: sgs[1]!.id, verdict: "CONDITIONAL", notes: "Scuffed corner." });
  await signOffInspection(inspector, { signoffId: sgs[2]!.id, verdict: "PASS" });

  let closed = true;
  try {
    await assertSignoffsComplete(insp.id, insp.number);
  } catch {
    closed = false;
  }
  check("with every concern signed, the inspection can close", closed);

  const final = await signoffsFor(insp.id);
  check("each verdict is kept separately", final.map((x) => x.verdict).join(",") === "PASS,CONDITIONAL,PASS");
  check("and the conditional one carries its note", final[1]?.notes === "Scuffed corner.");

  // Cleanup.
  await prisma.attestation.deleteMany({ where: { documentType: "INSPECTION", documentId: insp.id } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Inspection", entityId: insp.id } });
  await prisma.inspectionSignoff.deleteMany({ where: { inspectionId: insp.id } });
  await prisma.inspection.delete({ where: { id: insp.id } });

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`Chart: ${SOP_INSPECTION_MATRIX.length} groups x 3 checks = ${SOP_INSPECTION_MATRIX.length * 3} cells.`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
