import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, Mono, PageHeader, SectionCard, StatTile } from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { fmtDate, percent as pct } from "@/lib/format";
import { approveTaxRuleAction } from "./actions";
import { NewTaxRuleForm } from "./forms";

export const metadata = { title: "Tax master" };
export const dynamic = "force-dynamic";

/**
 * The Tax Master.
 *
 * ZAM/PUR/SOP-01 §4.8 applies tax "in accordance with the requirements of the
 * Income Tax Ordinance currently applicable in Pakistan", and the payment flow
 * sends the computation to KPMG — so the SOP deliberately fixes no percentage,
 * because the applicable rate changes without the SOP changing.
 *
 * That is why this screen exists and why it starts empty. Two rates used to be
 * hard-coded and contradicted each other: 18% in configuration and 16% on the
 * Cost Analysis Form. Neither had any authority in either document.
 */
export default async function TaxMasterPage() {
  const { ctx, authorized } = await pageContext(P.TAX_VIEW, P.TAX_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Tax master" message="You do not have access to tax configuration." />;
  }
  const canManage = ctx.user.permissions.includes(P.TAX_MANAGE);
  const canApprove =
    ctx.user.permissions.includes(P.TAX_VERIFY) || ctx.user.permissions.includes(P.TAX_MANAGE);

  const rules = await prisma.taxRule.findMany({
    orderBy: [{ code: "asc" }, { effectiveFrom: "desc" }],
    include: {
      entity: { select: { code: true } },
      createdBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      _count: { select: { poItems: true } },
    },
  });

  const now = new Date();
  const inForce = rules.filter(
    (r) => r.active && r.effectiveFrom <= now && (!r.effectiveTo || r.effectiveTo >= now),
  );
  const unapproved = rules.filter((r) => !r.approvedAt);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Tax master" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Tax master"
        subtitle="The applicable Government of Pakistan taxes, effective-dated. Cost analysis, orders, invoices and payments all read from here — a rate is never written into the code."
      />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Rates in force" value={inForce.length} tone={inForce.length ? undefined : "warning"} />
        <StatTile label="Recorded in total" value={rules.length} />
        <StatTile
          label="Awaiting approval"
          value={unapproved.length}
          hint="A rate nobody approved should not price an order"
          tone={unapproved.length ? "warning" : undefined}
        />
        <StatTile label="Lines priced" value={rules.reduce((a, r) => a + r._count.poItems, 0)} />
      </div>

      {rules.length === 0 && (
        <InlineAlert tone="warning">
          <strong>No tax rates are configured, and that is the correct state until somebody enters them.</strong>{" "}
          Neither SOP states a percentage — §4.8 defers to the Income Tax Ordinance and the payment flow routes the
          computation to KPMG. Until a rate is recorded here, a cost analysis prints its tax line as unset and says
          why, rather than printing a figure nobody authorised. The 18% that used to sit in configuration and the 16%
          on the Cost Analysis Form were both invented.
        </InlineAlert>
      )}

      {unapproved.length > 0 && (
        <InlineAlert tone="warning">
          {unapproved.length} rate{unapproved.length === 1 ? "" : "s"} recorded but not approved. A rate is entered by
          one person and approved by another, so a keying error does not become the price of everything.
        </InlineAlert>
      )}

      <SectionCard
        title="Rates"
        description="A rate change is a new row, never an edit. An order priced under the old rate keeps it."
        bodyClassName="px-0 py-0"
      >
        {rules.length === 0 ? (
          <p className="px-4 py-6 text-xs text-[var(--c-text-tertiary)]">
            Nothing recorded yet. Add the applicable taxes below.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: "7rem" }}>Code</th>
                  <th style={{ minWidth: "12rem" }}>Name</th>
                  <th style={{ width: "7rem" }}>Applies to</th>
                  <th style={{ width: "6rem" }}>Rate</th>
                  <th style={{ width: "8rem" }}>Vendor status</th>
                  <th style={{ width: "6rem" }}>Entity</th>
                  <th style={{ width: "11rem" }}>Effective</th>
                  <th style={{ width: "8rem" }}>Approved</th>
                  <th style={{ width: "5rem" }}>Used</th>
                  {canApprove && <th style={{ width: "8rem" }} />}
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  const live =
                    r.active && r.effectiveFrom <= now && (!r.effectiveTo || r.effectiveTo >= now);
                  return (
                    <tr key={r.id}>
                      <td>
                        <Mono>{r.code}</Mono>
                      </td>
                      <td>
                        {r.name}
                        {r.sourceReference && (
                          <span className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">
                            {r.sourceReference}
                          </span>
                        )}
                      </td>
                      <td>{r.appliesTo === "BOTH" ? "Goods & services" : r.appliesTo.toLowerCase()}</td>
                      <td className="tnum">
                        {r.method === "FIXED" ? `PKR ${r.percent}` : pct(r.percent, 2)}
                        {r.withholding && (
                          <Badge tone="info" className="ml-1">
                            WHT
                          </Badge>
                        )}
                      </td>
                      <td>{r.vendorTaxStatus === "ANY" ? "Any" : r.vendorTaxStatus.replace("_", "-")}</td>
                      <td>{r.entity?.code ?? "All"}</td>
                      <td className="text-2xs">
                        {fmtDate(r.effectiveFrom)}
                        {r.effectiveTo ? ` → ${fmtDate(r.effectiveTo)}` : " → open"}
                        {live ? (
                          <Badge tone="success" className="ml-1">
                            in force
                          </Badge>
                        ) : null}
                      </td>
                      <td className="text-2xs">
                        {r.approvedAt ? (
                          <>
                            {r.approvedBy?.name}
                            <span className="block text-[var(--c-text-tertiary)]">{fmtDate(r.approvedAt)}</span>
                          </>
                        ) : (
                          <Badge tone="warning">not approved</Badge>
                        )}
                      </td>
                      <td className="tnum">{r._count.poItems}</td>
                      {canApprove && (
                        <td>
                          {!r.approvedAt && r.createdById !== ctx.user.id && (
                            <ActionButton
                              action={approveTaxRuleAction}
                              payload={{ id: r.id }}
                              label="Approve"
                              size="xs"
                              tone="secondary"
                            />
                          )}
                          {!r.approvedAt && r.createdById === ctx.user.id && (
                            <span className="text-2xs text-[var(--c-text-tertiary)]">
                              You entered this
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {canManage && <NewTaxRuleForm entities={ctx.entities} />}

      <InlineAlert tone="info">
        Goods and services can be taxed differently, so tax applies at line level and the rate that was applied is
        written onto the line. A change here never restates an order that has already been priced — which is what
        keeps a reconciliation tying out a year later.
      </InlineAlert>
    </div>
  );
}
