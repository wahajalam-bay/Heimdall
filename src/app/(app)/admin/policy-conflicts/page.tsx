import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_DEFS, getConfig } from "@/lib/config";
import {
  BLACKLIST_GROUNDS,
  CLASSIFICATION_DIMENSIONS,
  COST_ANALYSIS_LAYOUTS,
  PAYMENT_ROUTES,
  PERFORMANCE_INSTRUMENTS,
  POLICY_CHOICES,
  PQ_SECTIONS,
  PQ_SECTION_TOTAL,
  QUALITY_METHODS,
  RATING_SCALES,
  taxRates,
} from "@/lib/policy";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { Badge, InlineAlert, Mono, PageHeader, SectionCard, StatTile } from "@/components/ui/primitives";
import { ConfigForm } from "../AdminAccessForms";

export const metadata = { title: "Policy decisions" };
export const dynamic = "force-dynamic";

/**
 * The open questions, on one screen.
 *
 * Two SOPs govern this system and they disagree with each other in places and
 * with their own annexures in others. Nothing in the code picks a winner. Each
 * contested value runs on a stated reading with a stated source, and this page
 * is where somebody with the authority to settle it can see what is running,
 * what the alternative is, and which passage each comes from.
 *
 * A setting still on its shipped reading is marked `awaiting confirmation` — it
 * is working, but nobody has agreed it is right, and the compliance report
 * counts it as unconfirmed rather than compliant.
 */
export default async function PolicyConflictsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { ctx, authorized } = await pageContext(P.CONFIG_MANAGE);
  if (!authorized) {
    return (
      <AccessDenied
        title="Policy decisions"
        message="Settling a policy conflict changes how the system behaves for everybody in the entity, so it needs the business-rules permission."
      />
    );
  }

  const sp = await searchParams;
  const requested = first(sp.entity) ?? null;
  const entityId = requested && ctx.entities.some((e) => e.id === requested) ? requested : null;
  const scopeName = entityId ? ctx.entities.find((e) => e.id === entityId)?.name : null;
  const scopeCode = entityId ? ctx.entities.find((e) => e.id === entityId)?.code : null;

  const stored = await prisma.configSetting.findMany({
    where: { key: { startsWith: "policy." } },
    select: { key: true, entityId: true, updatedAt: true, updatedBy: true },
  });

  const rows = await Promise.all(
    POLICY_CHOICES.map(async (choice) => {
      const def = CONFIG_DEFS.find((d) => d.key === choice.key);
      const value = String(await getConfig(choice.key, entityId));
      const entityRow = entityId ? stored.find((s) => s.key === choice.key && s.entityId === entityId) : null;
      const globalRow = stored.find((s) => s.key === choice.key && s.entityId === null);
      const settled = Boolean(entityRow ?? globalRow);
      return {
        choice,
        def,
        value,
        settledAt: (entityRow ?? globalRow)?.updatedAt ?? null,
        settledBy: (entityRow ?? globalRow)?.updatedBy ?? null,
        awaiting: choice.confirm && !settled,
      };
    }),
  );

  const awaiting = rows.filter((r) => r.awaiting);
  const rates = await taxRates(entityId);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Policy decisions" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Policy decisions"
        subtitle="Where the two SOPs disagree, or a document disagrees with its own annexure, the system runs on a stated reading rather than a guess. This is every such reading, its source, and the alternative."
      />

      <div className="card flex flex-row flex-wrap items-end gap-3 px-3.5 py-3">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-[16rem]">
            <span className="label mb-1 block">Deciding for</span>
            <select className="field" name="entity" defaultValue={entityId ?? ""}>
              <option value="">Both entities — the group-wide reading</option>
              {ctx.entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.code} — {e.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary btn-sm">
            Show
          </button>
        </form>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="Contested settings" value={POLICY_CHOICES.length} />
        <StatTile
          label="Awaiting confirmation"
          value={awaiting.length}
          hint="Running, but on a reading nobody has agreed"
          tone={awaiting.length ? "warning" : "success"}
        />
        <StatTile label="Settled" value={rows.length - awaiting.length} />
        <StatTile label="Scope" value={scopeName ?? "Group"} href="/admin/entities" />
      </div>

      {awaiting.length > 0 && (
        <InlineAlert tone="warning" id="awaiting">
          {awaiting.length} setting{awaiting.length === 1 ? "" : "s"} still run on the reading the system chose when it
          read the documents. Each one works, and each one is a decision somebody should make deliberately. Choosing the
          same value the system already picked is a valid answer — it records that the reading was checked.
        </InlineAlert>
      )}

      {rows.map(({ choice, def, value, awaiting: pending, settledAt, settledBy }) => (
        <SectionCard
          key={choice.key}
          title={choice.question}
          description={`${choice.conflict}${scopeCode ? ` · deciding for ${scopeCode}` : " · group-wide"}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {pending ? (
                <Badge tone="warning">awaiting confirmation</Badge>
              ) : (
                <Badge tone="success">settled</Badge>
              )}
              {def && (
                <ConfigForm
                  configKey={choice.key}
                  label={choice.question}
                  description={def.description}
                  valueType={def.valueType as "number" | "boolean" | "string" | "json"}
                  currentValue={value}
                  defaultValue={def.default}
                  entities={ctx.entities}
                  entityId={entityId}
                  hasOverride={!pending}
                />
              )}
            </div>
          }
        >
          <div className="space-y-3">
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }} />
                    <th style={{ minWidth: "14rem" }}>Reading</th>
                    <th>Where it comes from</th>
                  </tr>
                </thead>
                <tbody>
                  {choice.variants.map((v) => {
                    const active = v.code === value;
                    return (
                      <tr key={v.code} className={active ? "bg-[var(--c-accent-wash)]" : undefined}>
                        <td>{active ? <Badge tone="accent">in force</Badge> : null}</td>
                        <td>
                          <span className={active ? "font-500" : undefined}>{v.label}</span>
                          <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{v.code}</Mono>
                        </td>
                        <td className="text-xs leading-5">{v.source}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs leading-5 text-[var(--c-text-secondary)]">
              <span className="label">Why this one</span> — {choice.rationale}
            </p>
            {settledAt && (
              <p className="text-2xs text-[var(--c-text-tertiary)]">
                Settled {settledAt.toISOString().slice(0, 10)}
                {settledBy ? ` by ${settledBy}` : ""}.
              </p>
            )}
          </div>
        </SectionCard>
      ))}

      {/* ── What each reading actually produces ─────────────────────────── */}

      <SectionCard
        title="Vendor performance instruments"
        description="PC-002, PC-003, PC-004, PC-005 — both instruments in full, so a reader can check the reading rather than trust it"
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Criterion</th>
                <th style={{ width: "7rem" }}>Weight</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(PERFORMANCE_INSTRUMENTS).flatMap(([code, criteria]) =>
                criteria.map((c, i) => (
                  <tr key={`${code}-${c.code}`}>
                    <td>{i === 0 ? <Mono>{code}</Mono> : null}</td>
                    <td>{c.name}</td>
                    <td className="tnum">{c.weightPercent}%</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Rating scales" description="PC-003" bodyClassName="px-0 py-0">
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Scale</th>
                  <th>Band</th>
                  <th style={{ width: "5rem" }}>Score</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(RATING_SCALES).flatMap(([code, bands]) =>
                  bands.map((b, i) => (
                    <tr key={`${code}-${b.label}`}>
                      <td>{i === 0 ? <Mono>{code}</Mono> : null}</td>
                      <td>{b.label}</td>
                      <td className="tnum">{b.score}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard
          title="Quality scoring"
          description="PC-004 — including the gap the form leaves"
          bodyClassName="px-0 py-0"
        >
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Band</th>
                  <th style={{ width: "5rem" }}>Score</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(QUALITY_METHODS).flatMap(([code, m]) => [
                  ...m.bands.map((b, i) => (
                    <tr key={`${code}-${b.from}`}>
                      <td>{i === 0 ? <Mono>{code}</Mono> : null}</td>
                      <td>
                        {m.basis === "COMPLAINTS"
                          ? `${b.from}–${b.to} complaints`
                          : `${b.from}–${b.to}% accepted`}
                      </td>
                      <td className="tnum">{b.score}</td>
                    </tr>
                  )),
                  ...m.gaps.map((g) => (
                    <tr key={`${code}-gap`}>
                      <td />
                      <td colSpan={2} className="text-xs text-[var(--c-warn-text)]">
                        {g}
                      </td>
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Pre-qualification sections"
        description={`PC-006 — the form's own maxima sum to ${PQ_SECTION_TOTAL}, against a printed total of 60`}
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Section</th>
                <th style={{ width: "8rem" }}>Printed max</th>
              </tr>
            </thead>
            <tbody>
              {PQ_SECTIONS.map((s) => (
                <tr key={s.code}>
                  <td>{s.name}</td>
                  <td className="tnum">{s.max}</td>
                </tr>
              ))}
              <tr>
                <td className="font-500">Sum of the sections</td>
                <td className="tnum font-500">{PQ_SECTION_TOTAL}</td>
              </tr>
              <tr>
                <td className="text-[var(--c-warn-text)]">Total printed in the header</td>
                <td className="tnum text-[var(--c-warn-text)]">60</td>
              </tr>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="Payment routes"
        description="PC-010 — each entity's own chain, step for step as drawn"
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "12rem" }}>Route</th>
                <th style={{ width: "3rem" }}>#</th>
                <th style={{ width: "11rem" }}>Who</th>
                <th>What happens</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(PAYMENT_ROUTES).flatMap(([code, r]) =>
                r.steps.map((st, i) => (
                  <tr key={`${code}-${st.seq}`}>
                    <td>
                      {i === 0 ? (
                        <>
                          <Mono className="block text-2xs">{code}</Mono>
                          <span className="text-2xs text-[var(--c-text-tertiary)]">
                            {r.documents.length} documents
                            {r.collectionDays.length ? " · collection Tue & Fri" : ""}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td className="tnum">{st.seq}</td>
                    <td>
                      {st.actor}
                      {st.external ? ` (${st.external})` : ""}
                    </td>
                    <td className="text-xs leading-5">
                      {st.action}
                      {st.canReject ? (
                        <Badge tone="warning" className="ml-2">
                          can reject
                        </Badge>
                      ) : null}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Cost Analysis layouts" description="PC-011" bodyClassName="px-0 py-0">
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Layout</th>
                  <th style={{ width: "6rem" }}>Vendors</th>
                  <th style={{ width: "5rem" }}>Rows</th>
                  <th style={{ width: "7rem" }}>Computes tax</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(COST_ANALYSIS_LAYOUTS).map(([code, l]) => (
                  <tr key={code}>
                    <td>
                      {l.label}
                      <Mono className="mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{code}</Mono>
                    </td>
                    <td className="tnum">{l.vendorColumns}</td>
                    <td className="tnum">{l.lineRows}</td>
                    <td>{l.computesTax ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard title="Tax rates in force" description="PC-012">
          {rates.length === 0 ? (
            <InlineAlert tone="warning">
              No tax rate is configured{scopeName ? ` for ${scopeName}` : ""}, and that is the correct state until
              somebody sets one. Neither SOP states a percentage — §4.8 defers to the Income Tax Ordinance and both
              payment flows route the computation to KPMG. The 18% that used to sit in configuration and the 16% on the
              Cost Analysis Form were both invented, and they contradicted each other. Until a rate is entered, a form
              prints the tax line as unset.
            </InlineAlert>
          ) : (
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th>Tax</th>
                    <th style={{ width: "6rem" }}>Rate</th>
                    <th style={{ width: "10rem" }}>Effective from</th>
                  </tr>
                </thead>
                <tbody>
                  {rates.map((r) => (
                    <tr key={`${r.code}-${r.effectiveFrom}`}>
                      <td>{r.label}</td>
                      <td className="tnum">{r.percent}%</td>
                      <td>{new Date(r.effectiveFrom).toISOString().slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Blacklisting grounds"
        description="PC-019 — each entity's own list, verbatim and not merged"
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "6rem" }}>Entity</th>
                <th>Ground</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(BLACKLIST_GROUNDS).flatMap(([code, grounds]) =>
                grounds.map((g, i) => (
                  <tr key={`${code}-${g.code}`}>
                    <td>{i === 0 ? <Mono>{code}</Mono> : null}</td>
                    <td>{g.label}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="Classification dimensions"
        description="PC-015 — four taxonomies appear across the documents and no mapping between them is supplied, so they are held side by side rather than merged"
        bodyClassName="px-0 py-0"
      >
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: "13rem" }}>Dimension</th>
                <th style={{ width: "13rem" }}>Source</th>
                <th>Values</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(CLASSIFICATION_DIMENSIONS).map(([code, d]) => (
                <tr key={code}>
                  <td>{d.label}</td>
                  <td className="text-2xs">{d.source}</td>
                  <td className="text-xs leading-5">{d.values.join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <InlineAlert tone="info">
        Five conflicts are not settled here because they need a document nobody has supplied, not a choice between
        readings: the Vendor Performance Evaluation Form the SOP itself marks &ldquo;Form To Be Attached&rdquo;, the
        definition of JEFFI, the Financial Authority Limits Policy behind every approval threshold, the definition of an
        &ldquo;Exceptional Purchase&rdquo;, and whether Sage or SAP is the book of record. Those are listed in{" "}
        <Mono>docs/procurement-os-external-sources-required.md</Mono>.
      </InlineAlert>
    </div>
  );
}
