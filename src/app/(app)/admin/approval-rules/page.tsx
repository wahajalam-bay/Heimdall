import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs, TabNav } from "@/components/ui/nav";
import {
  Badge,
  EmptyState,
  InlineAlert,
  Mono,
  PageHeader,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { humanize } from "@/lib/domain";
import { money } from "@/lib/format";
import { adminOptions, toggleApprovalRuleAction } from "../actions";
import { ApprovalRuleForm } from "../AdminAccessForms";

export const metadata = { title: "Approval rules" };
export const dynamic = "force-dynamic";

const DOC_TABS = ["ALL", "PR", "PO", "INVOICE", "PETTY_CASH", "DISPOSAL", "MATERIAL_DEMAND", "STORE_TRANSFER", "VENDOR"];

export default async function AdminApprovalRulesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { authorized } = await pageContext(P.APPROVAL_RULE_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Approval rules" message="You do not have permission to manage approval rules." />;
  }

  const requested = first((await searchParams).tab) ?? "ALL";
  const tab = DOC_TABS.includes(requested) ? requested : "ALL";

  const [rules, options, instances] = await Promise.all([
    prisma.approvalRule.findMany({
      orderBy: [{ documentType: "asc" }, { priority: "asc" }, { minAmount: "asc" }],
      include: {
        entity: { select: { id: true, code: true } },
        department: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        steps: {
          orderBy: { sequence: "asc" },
          include: { role: { select: { id: true, code: true, name: true } } },
        },
        _count: { select: { instances: true } },
      },
    }),
    adminOptions(),
    prisma.approvalInstance.groupBy({
      by: ["ruleId", "status"],
      _count: { _all: true },
    }),
  ]);

  const usage = new Map<string, { open: number; done: number }>();
  for (const i of instances) {
    if (!i.ruleId) continue;
    const cur = usage.get(i.ruleId) ?? { open: 0, done: 0 };
    if (["PENDING", "IN_PROGRESS"].includes(i.status)) cur.open += i._count._all;
    else cur.done += i._count._all;
    usage.set(i.ruleId, cur);
  }

  const filtered = tab === "ALL" ? rules : rules.filter((r) => r.documentType === tab);
  const active = rules.filter((r) => r.active);
  const noSteps = rules.filter((r) => r.steps.length === 0);
  const unusedRoles = options.roles.filter((role) => !rules.some((r) => r.steps.some((s) => s.roleId === role.id)));

  // Overlapping value bands on the same document type and scope are a real risk:
  // two rules matching equally means the outcome depends on priority alone.
  const overlaps: string[] = [];
  for (const a of rules) {
    for (const b of rules) {
      if (a.id >= b.id) continue;
      if (a.documentType !== b.documentType) continue;
      if (a.entityId !== b.entityId || a.departmentId !== b.departmentId || a.categoryId !== b.categoryId) continue;
      if (a.procurementType !== b.procurementType) continue;
      const aMax = a.maxAmount ?? Number.POSITIVE_INFINITY;
      const bMax = b.maxAmount ?? Number.POSITIVE_INFINITY;
      if (a.minAmount < bMax && b.minAmount < aMax) {
        overlaps.push(`${a.name} and ${b.name} both match the same documents`);
      }
    }
  }

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Approval rules" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Approval rules"
        subtitle="Who approves what, at which value, for which entity. The most specific matching rule wins — entity, then department, then category, then procurement type."
        actions={
          <ApprovalRuleForm
            roles={options.roles}
            entities={options.entities}
            departments={options.departments}
            categories={options.categories}
          />
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Rules" value={rules.length} />
        <StatTile label="Active" value={active.length} tone="success" />
        <StatTile
          label="Rules with no steps"
          value={noSteps.length}
          tone={noSteps.length ? "danger" : "success"}
          hint="A matching document would have nobody to approve it"
        />
        <StatTile label="Approvals ever routed" value={rules.reduce((a, r) => a + r._count.instances, 0)} />
      </div>

      {noSteps.length > 0 && (
        <InlineAlert tone="danger">
          {noSteps.length} rule{noSteps.length === 1 ? " has" : "s have"} no approval steps:{" "}
          {noSteps.map((r) => r.name).join(", ")}. A document matching one of these would have no approver at all.
        </InlineAlert>
      )}

      {overlaps.length > 0 && (
        <InlineAlert tone="warning">
          Overlapping value bands detected — where two rules match equally, the outcome depends on priority alone:{" "}
          {[...new Set(overlaps)].slice(0, 3).join("; ")}
          {overlaps.length > 3 ? ` and ${overlaps.length - 3} more` : ""}.
        </InlineAlert>
      )}

      {unusedRoles.length > 0 && (
        <InlineAlert tone="info">
          {unusedRoles.length} role{unusedRoles.length === 1 ? " appears" : "s appear"} in no approval step:{" "}
          {unusedRoles.slice(0, 6).map((r) => r.name).join(", ")}
          {unusedRoles.length > 6 ? ` and ${unusedRoles.length - 6} more` : ""}. Not a problem in itself, but worth
          knowing which roles never get asked.
        </InlineAlert>
      )}

      <TabNav
        baseHref="/admin/approval-rules"
        active={tab}
        tabs={DOC_TABS.map((d) => ({
          key: d,
          label: d === "ALL" ? "All" : humanize(d),
          count: d === "ALL" ? rules.length : rules.filter((r) => r.documentType === d).length,
        }))}
      />

      {filtered.length === 0 ? (
        <EmptyState
          title="No rules in this view"
          description="Without a matching rule, documents of this type are approved by whoever holds the corresponding permission and no chain is recorded."
        />
      ) : (
        <div className="space-y-4">
          {filtered.map((r) => {
            const u = usage.get(r.id) ?? { open: 0, done: 0 };
            return (
              <SectionCard
                key={r.id}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {r.name}
                    <Badge tone="neutral">{humanize(r.documentType)}</Badge>
                    {!r.active && <Badge tone="danger">Disabled</Badge>}
                    {r.requiresCpc && <Badge tone="warning">CPC required</Badge>}
                    {r.steps.length === 0 && <Badge tone="danger">No steps</Badge>}
                  </span>
                }
                description={
                  <span className="flex flex-wrap items-center gap-2">
                    <Mono>{r.code}</Mono>
                    <span>·</span>
                    <span>
                      {money(r.minAmount)} to {r.maxAmount ? money(r.maxAmount) : "no upper limit"}
                    </span>
                    <span>·</span>
                    <span>priority {r.priority}</span>
                    {u.open > 0 && (
                      <>
                        <span>·</span>
                        <span className="text-[var(--c-warning)]">{u.open} in flight</span>
                      </>
                    )}
                  </span>
                }
                actions={
                  <>
                    <ApprovalRuleForm
                      roles={options.roles}
                      entities={options.entities}
                      departments={options.departments}
                      categories={options.categories}
                      triggerLabel="Edit rule"
                      initial={{
                        id: r.id,
                        code: r.code,
                        name: r.name,
                        description: r.description,
                        documentType: r.documentType,
                        entityId: r.entityId,
                        departmentId: r.departmentId,
                        categoryId: r.categoryId,
                        procurementType: r.procurementType,
                        minAmount: r.minAmount,
                        maxAmount: r.maxAmount,
                        priority: r.priority,
                        requiresCpc: r.requiresCpc,
                        active: r.active,
                        steps: r.steps.map((s) => ({
                          sequence: s.sequence,
                          name: s.name,
                          roleId: s.roleId,
                          approverType: s.approverType,
                          slaHours: s.slaHours,
                          requireAll: s.requireAll,
                          optional: s.optional,
                          commentRequired: s.commentRequired,
                        })),
                      }}
                    />
                    <ActionButton
                      action={toggleApprovalRuleAction}
                      payload={{ id: r.id }}
                      label={r.active ? "Disable" : "Enable"}
                      tone={r.active ? "danger-soft" : "secondary"}
                      size="sm"
                      reasonLabel={r.active ? "Why is this rule being disabled?" : "Why is this rule being enabled?"}
                    />
                  </>
                }
              >
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="neutral">{r.entity ? r.entity.code : "Any entity"}</Badge>
                    <Badge tone="neutral">{r.department ? r.department.name : "Any department"}</Badge>
                    <Badge tone="neutral">{r.category ? r.category.name : "Any category"}</Badge>
                    <Badge tone="neutral">
                      {r.procurementType ? humanize(r.procurementType) : "Any procurement type"}
                    </Badge>
                  </div>

                  {r.description && (
                    <p className="text-xs leading-5 text-[var(--c-text-secondary)]">{r.description}</p>
                  )}

                  {r.steps.length === 0 ? (
                    <InlineAlert tone="danger">
                      This rule has no steps. Any matching document would be left without an approver.
                    </InlineAlert>
                  ) : (
                    <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--c-border)]">
                      <table className="dt">
                        <thead>
                          <tr>
                            <th style={{ width: "3rem" }}>#</th>
                            <th>Step</th>
                            <th>Approver</th>
                            <th className="text-right">SLA</th>
                            <th>Behaviour</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.steps.map((s) => (
                            <tr key={s.id}>
                              <td className="num text-xs text-[var(--c-text-tertiary)]">{s.sequence}</td>
                              <td className="text-xs">{s.name}</td>
                              <td className="text-xs">
                                {s.approverType === "ROLE" ? (
                                  s.role ? (
                                    s.role.name
                                  ) : (
                                    <Badge tone="danger">Role missing</Badge>
                                  )
                                ) : (
                                  <Badge tone="info">{humanize(s.approverType)}</Badge>
                                )}
                              </td>
                              <td className="num text-2xs">{s.slaHours} h</td>
                              <td className="text-2xs">
                                <span className="flex flex-wrap gap-1">
                                  {s.optional && <Badge tone="neutral">Optional</Badge>}
                                  {s.requireAll && <Badge tone="info">All must approve</Badge>}
                                  {s.commentRequired && <Badge tone="neutral">Comment required</Badge>}
                                  {!s.optional && !s.requireAll && !s.commentRequired && (
                                    <span className="text-[var(--c-text-tertiary)]">Standard</span>
                                  )}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <p className="text-2xs text-[var(--c-text-tertiary)]">
                    {r._count.instances} approval{r._count.instances === 1 ? "" : "s"} routed through this rule
                    {u.open > 0 ? `, ${u.open} still in flight` : ""}.
                  </p>
                </div>
              </SectionCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
