import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Badge, InlineAlert, PageHeader, SectionCard, StatTile } from "@/components/ui/primitives";

export const metadata = { title: "Administration" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { user, authorized } = await pageContext(
    P.CONFIG_MANAGE,
    P.USER_MANAGE,
    P.ROLE_MANAGE,
    P.MASTER_DATA_MANAGE,
    P.APPROVAL_RULE_MANAGE,
  );
  if (!authorized) {
    return <AccessDenied title="Administration" message="You do not have permission to administer this system." />;
  }

  const [
    users,
    roles,
    entities,
    departments,
    projects,
    stores,
    categories,
    items,
    rules,
    criteria,
    docTypes,
    overrides,
    placedOnOrganogram,
  ] = await Promise.all([
      prisma.user.count(),
      prisma.role.count(),
      prisma.entity.count(),
      prisma.department.count(),
      prisma.project.count(),
      prisma.store.count(),
      prisma.category.count(),
      prisma.item.count(),
      prisma.approvalRule.count(),
      prisma.evaluationCriterion.count(),
      prisma.documentType.count(),
      prisma.configSetting.count(),
      prisma.user.count({ where: { grade: { not: null }, active: true } }),
    ]);

  const sections = [
    {
      title: "Access",
      items: [
        { href: "/admin/users", label: "Users", count: users, perm: P.USER_MANAGE, note: "Accounts, roles and entity access" },
        { href: "/admin/roles", label: "Roles and permissions", count: roles, perm: P.ROLE_MANAGE, note: "What each role may do" },
        {
          href: "/admin/organogram",
          label: "Organogram",
          count: placedOnOrganogram,
          perm: P.USER_MANAGE,
          note: "Supply chain hierarchy, reporting lines and points of contact",
        },
      ],
    },
    {
      title: "Rules",
      items: [
        {
          href: "/admin/policies",
          label: "Business rules",
          count: overrides,
          perm: P.CONFIG_MANAGE,
          note: "Thresholds and policy — no value is hard-coded",
        },
        {
          href: "/admin/approval-rules",
          label: "Approval rules",
          count: rules,
          perm: P.APPROVAL_RULE_MANAGE,
          note: "Who approves what, at which value",
        },
        {
          href: "/admin/evaluation-criteria",
          label: "Evaluation criteria",
          count: criteria,
          perm: P.MASTER_DATA_MANAGE,
          note: "The vendor pre-qualification scoring sheet",
        },
        {
          href: "/admin/document-types",
          label: "Document types",
          count: docTypes,
          perm: P.MASTER_DATA_MANAGE,
          note: "What must be attached, and what is confidential",
        },
      ],
    },
    {
      title: "Organisation",
      items: [
        { href: "/admin/entities", label: "Entities", count: entities, perm: P.MASTER_DATA_MANAGE, note: "Legal companies" },
        { href: "/admin/departments", label: "Departments", count: departments, perm: P.MASTER_DATA_MANAGE, note: "Cost centres and heads" },
        { href: "/admin/projects", label: "Projects", count: projects, perm: P.MASTER_DATA_MANAGE, note: "Construction and development" },
        { href: "/admin/stores", label: "Stores", count: stores, perm: P.MASTER_DATA_MANAGE, note: "Where inventory lives" },
      ],
    },
    {
      title: "Catalogue",
      items: [
        {
          href: "/admin/catalogue",
          label: "Categories and items",
          count: categories + items,
          perm: P.MASTER_DATA_MANAGE,
          note: `${categories} categories · ${items} items`,
        },
      ],
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Administration"
        title="System administration"
        subtitle="Access, business rules, organisation structure and the catalogue. Every change here is audited with the reason given."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Users" value={users} href="/admin/users" />
        <StatTile label="Roles" value={roles} href="/admin/roles" />
        <StatTile
          label="On the organogram"
          value={placedOnOrganogram}
          hint="Supply chain hierarchy and points of contact"
          href="/admin/organogram"
        />
        <StatTile label="Approval rules" value={rules} href="/admin/approval-rules" />
        <StatTile
          label="Rule overrides in force"
          value={overrides}
          hint="Entity or global overrides of a shipped default"
          href="/admin/policies"
        />
      </div>

      <InlineAlert tone="info">
        Nothing in the procurement engine hard-codes a threshold. Business rules resolve entity-specific first, then
        global, then the shipped default — which is why changing policy is a configuration task, not a code change.
      </InlineAlert>

      {sections.map((section) => (
        <SectionCard key={section.title} title={section.title}>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {section.items.map((item) => {
              const allowed = userHasPermission(user, item.perm);
              return allowed ? (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-xl border border-border px-3.5 py-3 transition-colors hover:bg-[var(--c-surface-hover)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-600">{item.label}</span>
                    <Badge tone="neutral">{item.count}</Badge>
                  </div>
                  <span className="mt-1 block text-2xs text-muted">{item.note}</span>
                </Link>
              ) : (
                <div
                  key={item.href}
                  className="rounded-xl border border-dashed border-border px-3.5 py-3 opacity-60"
                >
                  <span className="block text-xs font-600">{item.label}</span>
                  <span className="mt-1 block text-2xs text-[var(--c-text-tertiary)]">
                    Requires the {item.perm} permission.
                  </span>
                </div>
              );
            })}
          </div>
        </SectionCard>
      ))}
    </div>
  );
}
