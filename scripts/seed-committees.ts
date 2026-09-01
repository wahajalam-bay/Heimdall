/**
 * Seeds the two rosters the SOP names: the Cross Functional Team (`image21`)
 * and the Rental & Negotiation Committee (`image22`).
 *
 *   npx tsx scripts/seed-committees.ts
 *
 * Both documents name individuals. Where a person already has an account the
 * seat is linked to it; where they do not, the name is carried as text and the
 * link left null — a seat held by somebody without a login is a real situation,
 * and inventing an account for them would be worse than recording the gap.
 *
 * Idempotent.
 */
import { prisma } from "../src/lib/db";
import { ENTITY_CODES } from "../src/lib/domain";
import { CFT_SEATS, RNC_ROSTER } from "../src/server/buildout-checklist";

/** Matches a document name to a user account, tolerantly but not loosely. */
async function findUser(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Exact first, then a surname-and-forename containment match. Anything looser
  // starts assigning committee seats to the wrong people.
  const exact = await prisma.user.findFirst({
    where: { name: { equals: trimmed, mode: "insensitive" }, active: true },
    select: { id: true, name: true },
  });
  if (exact) return exact;

  const parts = trimmed.split(/\s+/).filter((p) => p.length > 2);
  if (parts.length < 2) return null;
  const candidates = await prisma.user.findMany({
    where: {
      active: true,
      AND: parts.map((p) => ({ name: { contains: p, mode: "insensitive" as const } })),
    },
    select: { id: true, name: true },
  });
  return candidates.length === 1 ? candidates[0] : null;
}

async function main() {
  const zam = await prisma.entity.findFirst({ where: { code: ENTITY_CODES.ZM } });
  if (!zam) throw new Error("Zameen Media entity not found.");

  console.log("\nCross Functional Team — image21\n");
  let cftLinked = 0;
  let cftUnlinked = 0;
  for (const [i, seat] of CFT_SEATS.entries()) {
    const member = await findUser(seat.member);
    const proxy = seat.proxy ? await findUser(seat.proxy) : null;
    if (member) cftLinked += 1;
    else cftUnlinked += 1;

    const data = {
      memberId: member?.id ?? null,
      memberName: seat.member,
      proxyId: proxy?.id ?? null,
      proxyName: seat.proxy,
      active: true,
      sequence: (i + 1) * 10,
    };
    const existing = await prisma.cfcMember.findUnique({
      where: { entityId_seat: { entityId: zam.id, seat: seat.seat } },
    });
    if (existing) await prisma.cfcMember.update({ where: { id: existing.id }, data });
    else await prisma.cfcMember.create({ data: { ...data, entityId: zam.id, seat: seat.seat } });

    console.log(
      `  ${seat.seat.padEnd(18)} ${seat.member.padEnd(22)}${member ? "✓" : "·"}  proxy ${
        (seat.proxy ?? "— none named").padEnd(20)
      }${seat.proxy ? (proxy ? "✓" : "·") : ""}`,
    );
  }
  const noProxy = CFT_SEATS.filter((s) => !s.proxy);
  console.log(`\n  ${CFT_SEATS.length} seats · ${cftLinked} linked to an account · ${cftUnlinked} by name only`);
  if (noProxy.length) {
    console.log(
      `  ${noProxy.length} seat(s) the document names no proxy for: ${noProxy.map((s) => s.seat).join(", ")}.`,
    );
    console.log("  Carried as null rather than filled in — a seat with nobody to stand in is a real gap.");
  }

  console.log("\n\nRental & Negotiation Committee — image22\n");
  const byRegion = new Map<string, number>();
  for (const [i, row] of RNC_ROSTER.entries()) {
    const user = await findUser(row.name);
    const data = {
      userId: user?.id ?? null,
      designation: row.designation,
      memberType: row.memberType,
      isHead: row.isHead ?? false,
      active: true,
      sequence: (i + 1) * 10,
    };
    const existing = await prisma.rncMember.findUnique({
      where: {
        entityId_region_memberName: {
          entityId: zam.id,
          region: row.region,
          memberName: row.name,
        },
      },
    });
    if (existing) await prisma.rncMember.update({ where: { id: existing.id }, data });
    else
      await prisma.rncMember.create({
        data: { ...data, entityId: zam.id, region: row.region, memberName: row.name },
      });

    byRegion.set(row.region, (byRegion.get(row.region) ?? 0) + 1);
    console.log(
      `  ${row.region.padEnd(8)} ${row.name.padEnd(24)} ${row.designation.padEnd(22)} ` +
        `${row.memberType}${row.isHead ? " · HEAD" : ""}${user ? "  ✓" : "  ·"}`,
    );
  }

  console.log("");
  for (const [region, count] of byRegion) {
    const voting = RNC_ROSTER.filter((r) => r.region === region && r.memberType !== "OBSERVER");
    const nonHead = voting.filter((r) => !r.isHead).length;
    console.log(
      `  ${region.padEnd(8)} ${count} seat(s) · ${voting.length} voting · ${nonHead} voting beside the head`,
    );
  }
  console.log(
    "\n  RN-004 asks for three permanent members beside the head. Central has enough;",
  );
  console.log(
    "  North and South are listed with three members in total including a shared Country",
  );
  console.log(
    "  Head, so three beside the head is arithmetically impossible there as written. The",
  );
  console.log(
    "  quorum rule caps the requirement at the region's own voting headcount and records",
  );
  console.log("  on each case what was actually required, rather than inventing a smaller number.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
