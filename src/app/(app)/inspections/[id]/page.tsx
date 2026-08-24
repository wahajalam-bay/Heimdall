import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { userHasPermission } from "@/lib/rbac";
import { INSPECTION_TEMPLATES, templateForCategoryCode } from "@/server/receiving";
import { documentTimeline } from "@/server/timeline";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  BlockedNotice,
  Card,
  DefList,
  InlineAlert,
  MetaItem,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import { Timeline } from "@/components/ui/workflow";
import { DocumentsPanel } from "@/components/domain/DocumentsPanel";
import { ActionButton } from "@/components/ui/forms";
import { humanize } from "@/lib/domain";
import { fmtDateTime, qty } from "@/lib/format";
import { assignInspectorAction } from "@/app/(app)/receiving/actions";
import { InspectionForm } from "./InspectionForm";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const i = await prisma.inspection.findUnique({ where: { id }, select: { number: true } });
  return { title: i ? `${i.number} — Inspection` : "Inspection" };
}

export default async function InspectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authorized } = await pageContext(P.INSPECTION_VIEW);
  if (!authorized) return <AccessDenied title="Inspection" />;

  const insp = await prisma.inspection.findUnique({
    where: { id },
    include: {
      po: {
        select: {
          id: true,
          number: true,
          entityId: true,
          entity: { select: { code: true } },
          vendor: { select: { id: true, name: true } },
          pr: { select: { id: true, number: true, title: true } },
        },
      },
      delivery: {
        select: {
          id: true,
          number: true,
          deliveryDate: true,
          store: { select: { id: true, name: true } },
          receivedBy: { select: { name: true } },
          grns: { select: { id: true, number: true, status: true } },
        },
      },
      inspector: { select: { id: true, name: true, title: true } },
      items: {
        orderBy: { lineNo: "asc" },
        include: { poItem: { select: { unit: true } }, item: { include: { category: { select: { code: true, name: true } } } } },
      },
      grns: { select: { id: true, number: true, status: true } },
    },
  });
  if (!insp) notFound();

  const [events, inspectors] = await Promise.all([
    documentTimeline("Inspection", insp.id),
    prisma.user.findMany({
      where: {
        active: true,
        roles: { some: { role: { code: { in: ["TECHNICAL_INSPECTOR", "IT_USER", "PM_USER", "DESIGN_USER"] } } } },
      },
      select: { id: true, name: true, title: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const template =
    INSPECTION_TEMPLATES.find((t) => t.code === insp.templateCode) ??
    templateForCategoryCode(insp.items[0]?.item?.category.code ?? null);

  const canPerform = userHasPermission(user, P.INSPECTION_PERFORM);
  const isOpen = ["PENDING", "IN_PROGRESS", "RE_INSPECTION_REQUIRED"].includes(insp.result);
  const presented = insp.items.reduce((a, i) => a + i.quantityInspected, 0);
  const passed = insp.items.reduce((a, i) => a + i.quantityPassed, 0);
  const failed = insp.items.reduce((a, i) => a + i.quantityFailed, 0);
  const grn = insp.grns[0] ?? insp.delivery?.grns[0];

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Operations", href: "/inspections" },
          { label: "Inspections", href: "/inspections" },
          { label: insp.number },
        ]}
      />

      <PageHeader
        eyebrow={`${insp.po?.entity.code ?? ""} · ${template.label}`}
        title={
          <span className="flex flex-wrap items-baseline gap-2.5">
            <span className="mono text-[1rem] text-muted">{insp.number}</span>
            <span>{insp.po?.vendor.name ?? "Technical inspection"}</span>
          </span>
        }
        meta={
          <>
            <MetaItem label="Result">
              <StatusBadge status={insp.result} />
            </MetaItem>
            <MetaItem label="Type">
              <Badge tone="neutral">{humanize(insp.inspectionType)}</Badge>
            </MetaItem>
            {insp.po && (
              <MetaItem label="PO">
                <RefLink href={`/po/${insp.po.id}`}>{insp.po.number}</RefLink>
              </MetaItem>
            )}
            {insp.delivery && (
              <MetaItem label="Receipt">
                <RefLink href={`/receiving/${insp.delivery.id}`}>{insp.delivery.number}</RefLink>
              </MetaItem>
            )}
            <MetaItem label="Inspector">{insp.inspector?.name ?? "Unassigned"}</MetaItem>
          </>
        }
        actions={
          <>
            {isOpen && !insp.inspectorId && canPerform && (
              <ActionButton
                action={assignInspectorAction}
                payload={{ inspectionId: insp.id, inspectorId: user.id }}
                label="Assign to me"
                tone="secondary"
              />
            )}
            {grn && (
              <Link href={`/grn/${grn.id}`} className="btn btn-secondary btn-sm">
                {grn.number}
              </Link>
            )}
            {!grn && !isOpen && insp.delivery && userHasPermission(user, P.GRN_CREATE) && (
              <Link href={`/grn/new?deliveryId=${insp.delivery.id}`} className="btn btn-primary btn-sm">
                Raise GRN
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Presented" value={qty(presented)} hint={`${insp.items.length} line(s)`} />
        <StatTile label="Passed" value={qty(passed)} tone={passed > 0 ? "success" : "default"} />
        <StatTile label="Failed" value={failed > 0 ? qty(failed) : "—"} tone={failed > 0 ? "danger" : "default"} />
        <StatTile
          label="GRN status"
          value={grn ? humanize(grn.status) : isOpen ? "Blocked" : "Ready"}
          hint={grn ? grn.number : isOpen ? "Inspection outstanding" : "Inspection cleared"}
          tone={grn ? "success" : isOpen ? "warning" : "accent"}
        />
      </div>

      {isOpen && (
        <BlockedNotice
          title="This inspection is outstanding"
          reasons={[
            "A goods receipt note cannot be posted for this delivery until the inspection is approved or conditionally approved.",
            insp.inspectorId
              ? `Assigned to ${insp.inspector?.name}.`
              : "No inspector has been assigned yet — the task is open to the responsible technical role.",
          ]}
        />
      )}
      {insp.result === "REJECTED" && (
        <InlineAlert tone="danger">
          <span className="font-600">Inspection rejected. </span>
          {insp.findings ?? "The goods have failed technical inspection and must not be taken into inventory."}
        </InlineAlert>
      )}
      {insp.result === "CONDITIONAL" && insp.conditions && (
        <InlineAlert tone="warning">
          <span className="font-600">Conditional acceptance: </span>
          {insp.conditions}
        </InlineAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <SectionCard title="Inspection record">
          <DefList
            columns={2}
            items={[
              { label: "Template", value: template.label },
              { label: "Department", value: insp.department ?? "—" },
              { label: "Scheduled", value: insp.scheduledAt ? fmtDateTime(insp.scheduledAt) : "—" },
              { label: "Inspected", value: insp.inspectedAt ? fmtDateTime(insp.inspectedAt) : "Not yet inspected" },
              {
                label: "Inspector",
                value: insp.inspector ? `${insp.inspector.name}${insp.inspector.title ? ` — ${insp.inspector.title}` : ""}` : "Unassigned",
              },
              { label: "Signed by", value: insp.signedByName ?? "—" },
              { label: "Signed at", value: insp.signedAt ? fmtDateTime(insp.signedAt) : "—" },
              { label: "Vendor", value: insp.po ? <RefLink href={`/vendors/${insp.po.vendor.id}`}>{insp.po.vendor.name}</RefLink> : "—" },
              { label: "Findings", value: insp.findings ?? "—", span: true },
              ...(insp.conditions ? [{ label: "Conditions", value: insp.conditions, span: true as const }] : []),
            ]}
          />
        </SectionCard>

        <SectionCard title="Assignment">
          {isOpen ? (
            <div className="space-y-3">
              <p className="text-xs leading-5 text-muted">
                Assign a named inspector so the task appears on their workspace and the service-level clock is owned.
              </p>
              <div className="space-y-1.5">
                {inspectors.slice(0, 8).map((i) => (
                  <div key={i.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-500">{i.name}</span>
                      <span className="block truncate text-2xs text-[var(--c-text-tertiary)]">{i.title ?? ""}</span>
                    </span>
                    {canPerform && (
                      <ActionButton
                        action={assignInspectorAction}
                        payload={{ inspectionId: insp.id, inspectorId: i.id }}
                        label="Assign"
                        tone="ghost"
                        size="xs"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <DefList
              columns={1}
              items={[
                { label: "Completed by", value: insp.signedByName ?? insp.inspector?.name ?? "—" },
                { label: "Result", value: <StatusBadge status={insp.result} /> },
                { label: "Completed", value: insp.inspectedAt ? fmtDateTime(insp.inspectedAt) : "—" },
              ]}
            />
          )}
        </SectionCard>
      </div>

      {isOpen && canPerform ? (
        <InspectionForm
          inspection={{
            id: insp.id,
            number: insp.number,
            type: insp.inspectionType,
            templateLabel: template.label,
          }}
          criteria={template.criteria}
          inspectorName={insp.inspector?.name ?? user.name}
          lines={insp.items.map((i) => ({
            id: i.id,
            lineNo: i.lineNo,
            description: i.description,
            quantityInspected: i.quantityInspected,
            unit: i.poItem?.unit ?? "EA",
            serialNumber: i.serialNumber,
          }))}
        />
      ) : (
        <SectionCard title="Line results" bodyClassName="px-0 py-0">
          {insp.items.length === 0 ? (
            <Card>
              <p className="text-xs text-muted">No lines on this inspection.</p>
            </Card>
          ) : (
            <div className="divide-y divide-[var(--c-border-subtle)]">
              {insp.items.map((i) => {
                let criteria: Array<{ key: string; label: string; value: string | number | boolean | null }> = [];
                try {
                  criteria = JSON.parse(i.criteriaResults);
                } catch {
                  criteria = [];
                }
                return (
                  <div key={i.id} className="px-4 py-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[0.8125rem] font-500">
                        Line {i.lineNo} · {i.description}
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge tone={i.verdict === "PASS" ? "success" : i.verdict === "FAIL" ? "danger" : "warning"}>
                          {humanize(i.verdict)}
                        </Badge>
                        <span className="tnum text-2xs text-muted">
                          {qty(i.quantityPassed)} passed / {qty(i.quantityFailed)} failed of{" "}
                          {qty(i.quantityInspected)}
                        </span>
                      </span>
                    </div>
                    <div className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-4">
                      {[
                        ["Serial / batch", i.serialNumber],
                        ["Model verified", i.modelVerified],
                        ["Specification verified", i.specVerified],
                        ["Configuration", i.configuration],
                        ["Condition", i.condition],
                        ["Accessories complete", i.accessoriesComplete ? "Yes" : "No"],
                      ]
                        .filter(([, v]) => Boolean(v))
                        .map(([label, value]) => (
                          <div key={String(label)}>
                            <div className="label">{String(label)}</div>
                            <div className="text-2xs">{String(value)}</div>
                          </div>
                        ))}
                    </div>
                    {criteria.length > 0 && (
                      <div className="mt-2.5 overflow-hidden rounded-lg border border-separator">
                        <table className="dt">
                          <thead>
                            <tr>
                              <th>Criterion</th>
                              <th>Result</th>
                            </tr>
                          </thead>
                          <tbody>
                            {criteria.map((c) => (
                              <tr key={c.key}>
                                <td className="text-xs">{c.label}</td>
                                <td className="text-xs">
                                  {typeof c.value === "boolean" ? (
                                    <Badge tone={c.value ? "success" : "danger"}>{c.value ? "Yes" : "No"}</Badge>
                                  ) : (
                                    (c.value ?? "—")
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {i.performanceNotes && (
                      <p className="mt-2 text-2xs leading-4 text-muted">{i.performanceNotes}</p>
                    )}
                    {i.notes && <p className="mt-1 text-2xs leading-4 text-[var(--c-text-tertiary)]">{i.notes}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <DocumentsPanel
          user={user}
          linkedType="INSPECTION"
          linkedId={insp.id}
          entityId={insp.po?.entityId ?? null}
          title="Inspection documents"
          description="Signed inspection form, test certificates, photographs and lab reports."
          defaultCategory="Inspection"
        />
        <SectionCard title="Activity">
          <Timeline events={events} emptyLabel="No activity recorded yet." />
        </SectionCard>
      </div>
    </div>
  );
}
