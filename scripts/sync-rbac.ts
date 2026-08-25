/**
 * Brings the database's permissions and role grants into line with the code.
 *
 * The seed builds RBAC from scratch, which is right for a fresh database and
 * useless for a running one — adding a permission would mean discarding every
 * transaction to pick it up. This reconciles instead: new codes are inserted,
 * renamed ones updated, new grants added.
 *
 * Grants are added, never removed. A permission taken out of a role definition
 * is reported rather than revoked, because silently stripping access from a live
 * system on the strength of a code edit is not a decision a script should make.
 *
 *   npx tsx scripts/sync-rbac.ts            # report and apply
 *   npx tsx scripts/sync-rbac.ts --dry-run  # report only
 */
import { prisma } from "../src/lib/db";
import { ALL_PERMISSIONS, PERMISSION_META, ROLE_DEFINITIONS } from "../src/lib/permissions";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const existing = await prisma.permission.findMany();
  const byCode = new Map(existing.map((p) => [p.code, p]));

  const added: string[] = [];
  const renamed: string[] = [];

  for (const code of ALL_PERMISSIONS) {
    const meta = PERMISSION_META[code] ?? { group: "General", name: code };
    const current = byCode.get(code);
    if (!current) {
      added.push(code);
      if (!dryRun) {
        await prisma.permission.create({ data: { code, name: meta.name, group: meta.group } });
      }
    } else if (current.name !== meta.name || current.group !== meta.group) {
      renamed.push(code);
      if (!dryRun) {
        await prisma.permission.update({ where: { id: current.id }, data: { name: meta.name, group: meta.group } });
      }
    }
  }

  const defined = new Set<string>(ALL_PERMISSIONS);
  const orphaned = existing.filter((p) => !defined.has(p.code)).map((p) => p.code);

  const permMap = new Map((await prisma.permission.findMany()).map((p) => [p.code, p.id]));
  const roles = await prisma.role.findMany({ include: { permissions: true } });
  const roleByCode = new Map(roles.map((r) => [r.code, r]));

  const grants: string[] = [];
  const missingRoles: string[] = [];
  const surplus: string[] = [];

  for (const def of ROLE_DEFINITIONS) {
    const role = roleByCode.get(def.code);
    if (!role) {
      missingRoles.push(def.code);
      continue;
    }
    const held = new Set(
      role.permissions
        .map((rp) => [...permMap.entries()].find(([, id]) => id === rp.permissionId)?.[0])
        .filter(Boolean) as string[],
    );
    const wanted = new Set(def.permissions);

    for (const code of wanted) {
      if (held.has(code)) continue;
      const permissionId = permMap.get(code);
      if (!permissionId) continue;
      grants.push(`${def.code} → ${code}`);
      if (!dryRun) {
        await prisma.rolePermission.create({ data: { roleId: role.id, permissionId } });
      }
    }
    for (const code of held) {
      if (!wanted.has(code)) surplus.push(`${def.code} still holds ${code}`);
    }
  }

  const label = dryRun ? "Would apply" : "Applied";
  console.log(`\n${label}:`);
  console.log(`  ${added.length} new permission(s)${added.length ? `: ${added.join(", ")}` : ""}`);
  console.log(`  ${renamed.length} permission label(s) updated`);
  console.log(`  ${grants.length} new role grant(s)`);
  if (grants.length) for (const g of grants) console.log(`      ${g}`);

  if (missingRoles.length) console.log(`\n  Roles defined in code but absent here: ${missingRoles.join(", ")}`);
  if (orphaned.length) console.log(`\n  Permissions in the database with no definition: ${orphaned.join(", ")}`);
  if (surplus.length) {
    console.log(`\n  Grants held beyond the definitions — left alone, review by hand:`);
    for (const s of surplus.slice(0, 20)) console.log(`      ${s}`);
    if (surplus.length > 20) console.log(`      …and ${surplus.length - 20} more`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
