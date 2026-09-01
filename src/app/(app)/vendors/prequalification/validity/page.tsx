import Link from "next/link";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  InlineAlert,
  Mono,
  PageHeader,
  RefLink,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/DataTable";
import { fmtDate } from "@/lib/format";
import { pqPreview, pqStanding, type PqState } from "@/server/prequalification";

export const metadata = { title: "Pre-qualification validity" };
export const dynamic = "force-dynamic";

const STATE_LABELS: Record<PqState, string> = {
  VALID: "Valid",
  EXPIRING: "Expiring",
  EXPIRED: "Expired",
  NOT_TRACKED: "No expiry in force",
  NO_APPROVAL_DATE: "No approval date",
};

const STATE_TONES: Record<PqState, "success" | "warning" | "danger" | "info"> = {
  VALID: "success",
  EXPIRING: "warning",
  EXPIRED: "danger",
  NOT_TRACKED: "info",
  NO_APPROVAL_DATE: "warning",
};

/**
 * Pre-qualification validity, and what turning it on would do.
 *
 * Meeting requirement 20 asks for PQ expiry after two years and
 * requalification. The enforcement already exists; what did not is the ability
 * to see it coming. Setting a two-year validity on a list that has never had one
 * does not start a clock — it finishes one that has been running unobserved, and
 * every vendor approved more than two years ago becomes ineligible in the same
 * instant. This page is where that decision is taken with the list in front of
 * somebody, rather than discovered from a refused requisition.
 */
export default async function PqValidityPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx, authorized } = await pageContext(P.VENDOR_VIEW);
  if (!authorized) {
    return <AccessDenied title="Pre-qualification validity" />;
  }

  const sp = await searchParams;
  const proposed = Number(first(sp.months) ?? 24) || 24;

  const [{ rows, validityMonths, warnDays }, preview] = await Promise.all([
    pqStanding({ entityId: ctx.entityId }),
    pqPreview(ctx.entityId, proposed),
  ]);

  const inForce = validityMonths > 0;
  const counted = (state: PqState) => rows.filter((r) => r.state === state).length;

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "Vendors", href: "/vendors" },
          { label: "Pre-qualification", href: "/vendors/prequalification" },
          { label: "Validity" },
        ]}
      />

      <PageHeader
        eyebrow="Vendors"
        title="Pre-qualification validity"
        subtitle="Meeting requirement 20 asks for PQ expiry after two years and requalification. Enforcement already refuses a lapsed vendor at sourcing — this is where the position is visible before it bites."
      />

      {inForce ? (
        <InlineAlert tone="info">
          A pre-qualification is valid for <strong>{validityMonths} months</strong> from approval for this company.
          Sourcing refuses a vendor past that date, and a fresh evaluation plus approval resets the clock.
        </InlineAlert>
      ) : (
        <InlineAlert tone="warning">
          No validity period is in force for this company, so no pre-qualification ever expires and requalification is
          never triggered. Zameen Media&rsquo;s own SOP §5.1 states no period; the two-year figure comes from meeting
          requirement 20, and setting it is a business decision — the preview below shows what it would cost.
        </InlineAlert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Approved vendors" value={rows.length} />
        <StatTile
          label="Expired"
          value={counted("EXPIRED")}
          hint={inForce ? "Refused at sourcing" : "Not applicable"}
          tone={counted("EXPIRED") ? "danger" : undefined}
        />
        <StatTile
          label={`Expiring within ${warnDays} days`}
          value={counted("EXPIRING")}
          tone={counted("EXPIRING") ? "warning" : undefined}
        />
        <StatTile
          label="No approval date"
          value={counted("NO_APPROVAL_DATE")}
          hint={counted("NO_APPROVAL_DATE") ? "Position cannot be computed" : "None"}
          tone={counted("NO_APPROVAL_DATE") ? "warning" : undefined}
        />
      </div>

      <SectionCard
        title="What a validity period would do"
        description="Before setting it. The figure that matters is the first one: how many vendors become ineligible the moment it is saved."
      >
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
          <label className="min-w-[12rem]">
            <span className="label mb-1 block">Proposed validity (months)</span>
            <select className="field" name="months" defaultValue={String(proposed)}>
              <option value="12">12 months</option>
              <option value="18">18 months</option>
              <option value="24">24 months — meeting requirement 20</option>
              <option value="36">36 months</option>
            </select>
          </label>
          <button type="submit" className="btn btn-secondary btn-sm">
            Recalculate
          </button>
        </form>

        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
          <StatTile
            label="Ineligible immediately"
            value={preview.expiredImmediately}
            hint={`At ${preview.proposedMonths} months`}
            tone={preview.expiredImmediately ? "danger" : undefined}
          />
          <StatTile label="Expiring within 90 days" value={preview.expiringWithin90} tone={preview.expiringWithin90 ? "warning" : undefined} />
          <StatTile label="Still valid" value={preview.stillValid} />
          <StatTile
            label="Cannot be placed"
            value={preview.undatable}
            hint={preview.undatable ? "No approval date on record" : "None"}
            tone={preview.undatable ? "warning" : undefined}
          />
        </div>

        {preview.expiredImmediately > 0 && (
          <>
            <InlineAlert tone="danger">
              At {preview.proposedMonths} months, {preview.expiredImmediately} vendor
              {preview.expiredImmediately === 1 ? "" : "s"} would become ineligible the moment the setting is saved —
              every requisition naming them would be refused until they are requalified. Requalify them first, or
              phase the change in.
            </InlineAlert>
            <div className="table-wrap mt-3">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "8rem" }}>Code</th>
                    <th style={{ minWidth: "14rem" }}>Vendor</th>
                    <th style={{ width: "10rem" }}>Approved</th>
                    <th style={{ width: "9rem" }} className="text-right">
                      Overdue by
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.wouldExpire.map((v) => (
                    <tr key={v.code}>
                      <td>
                        <Mono className="text-2xs">{v.code}</Mono>
                      </td>
                      <td>{v.name}</td>
                      <td className="text-2xs">{v.approvedAt ? fmtDate(v.approvedAt) : "—"}</td>
                      <td className="tnum text-right">{v.overdueDays}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {preview.expiredImmediately === 0 && preview.proposedMonths > 0 && (
          <InlineAlert tone="success">
            At {preview.proposedMonths} months nothing would become ineligible immediately. This is the safe moment to
            set it.
          </InlineAlert>
        )}

        <p className="mt-3 text-2xs text-[var(--c-text-tertiary)]">
          Set the value under{" "}
          <Link className="link" href="/admin/policies">
            Business rules
          </Link>{" "}
          → Policy · Vendors → &ldquo;Pre-qualification validity (months)&rdquo;. Nothing on this page changes it.
        </p>
      </SectionCard>

      <DataTable
        id="pq-standing"
        columns={[
          { key: "code", header: "Code", sortable: true, width: "8rem" },
          { key: "name", header: "Vendor", filterable: false },
          { key: "state", header: "Standing", filterable: true, sortable: true, width: "11rem" },
          { key: "approved", header: "Approved", sortable: true, width: "9rem" },
          { key: "expires", header: "Expires", sortable: true, width: "9rem" },
          { key: "remaining", header: "Remaining", sortable: true, align: "right", width: "8rem" },
          { key: "evaluated", header: "Last evaluated", sortable: true, width: "10rem" },
        ]}
        rows={rows.map((r) => ({
          id: r.vendorId,
          search: `${r.code} ${r.name}`,
          flag:
            r.state === "EXPIRED"
              ? ("danger" as const)
              : r.state === "EXPIRING" || r.state === "NO_APPROVAL_DATE"
                ? ("warning" as const)
                : null,
          cells: {
            code: <Mono className="text-2xs">{r.code}</Mono>,
            name: <RefLink href={`/vendors/${r.vendorId}`}>{r.name}</RefLink>,
            state: <Badge tone={STATE_TONES[r.state]}>{STATE_LABELS[r.state]}</Badge>,
            approved: r.approvedAt ? fmtDate(r.approvedAt) : "—",
            expires: r.expiresAt ? fmtDate(r.expiresAt) : "—",
            remaining:
              r.daysRemaining === null ? "—" : r.daysRemaining < 0 ? `${Math.abs(r.daysRemaining)}d ago` : `${r.daysRemaining}d`,
            evaluated: r.lastEvaluatedAt ? fmtDate(r.lastEvaluatedAt) : "Never evaluated",
          },
          values: {
            code: r.code,
            name: r.name,
            state: STATE_LABELS[r.state],
            approved: r.approvedAt ? r.approvedAt.toISOString().slice(0, 10) : "",
            expires: r.expiresAt ? r.expiresAt.toISOString().slice(0, 10) : "",
            remaining: r.daysRemaining ?? 1e9,
            evaluated: r.lastEvaluatedAt ? r.lastEvaluatedAt.toISOString().slice(0, 10) : "",
          },
        }))}
        emptyState="No approved vendors."
      />

      <p className="text-2xs text-[var(--c-text-tertiary)]">
        An approved vendor with no approval date on record is shown as unplaceable rather than valid. Calling it valid
        would be an assumption in the vendor&rsquo;s favour and calling it expired one against them, so it is neither
        — and the gap is visible instead.
      </p>
    </div>
  );
}
