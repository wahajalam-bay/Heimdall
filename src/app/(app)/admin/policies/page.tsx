import { prisma } from "@/lib/db";
import { first, pageContext, type SearchParams } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { CONFIG_DEFS, getConfig } from "@/lib/config";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import {
  Badge,
  InlineAlert,
  Mono,
  PageHeader,
  SectionCard,
  StatTile,
} from "@/components/ui/primitives";
import { ActionButton } from "@/components/ui/forms";
import { fmtDateTime } from "@/lib/format";
import { resetConfigAction } from "../actions";
import { ConfigForm } from "../AdminAccessForms";

export const metadata = { title: "Business rules" };
export const dynamic = "force-dynamic";

/** Renders a stored config value the way a human reads it. */
function display(value: unknown, valueType: string): string {
  if (value === null || value === undefined) return "—";
  if (valueType === "boolean") return value ? "Enabled" : "Disabled";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  if (typeof value === "object") return JSON.stringify(value);
  if (valueType === "number" && typeof value === "number" && value >= 1000) {
    return value.toLocaleString("en-PK");
  }
  return String(value);
}

export default async function AdminPoliciesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { ctx, authorized } = await pageContext(P.CONFIG_MANAGE);
  if (!authorized) {
    return <AccessDenied title="Business rules" message="You do not have permission to change business rules." />;
  }

  const sp = await searchParams;
  const requestedEntity = first(sp.entity) ?? null;
  const entityId = requestedEntity && ctx.entities.some((e) => e.id === requestedEntity) ? requestedEntity : null;

  const [stored, actors] = await Promise.all([
    prisma.configSetting.findMany({
      orderBy: [{ key: "asc" }],
      select: { id: true, key: true, value: true, entityId: true, updatedAt: true, updatedBy: true },
    }),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);
  const actorName = new Map(actors.map((a) => [a.id, a.name]));

  // Effective value per definition at the selected scope.
  const effective = await Promise.all(
    CONFIG_DEFS.map(async (def) => ({
      def,
      value: await getConfig(def.key, entityId),
      globalOverride: stored.find((s) => s.key === def.key && s.entityId === null) ?? null,
      entityOverride: entityId ? (stored.find((s) => s.key === def.key && s.entityId === entityId) ?? null) : null,
    })),
  );

  const groups = [...new Set(CONFIG_DEFS.map((d) => d.group))];
  const entityOverrideCount = stored.filter((s) => s.entityId !== null).length;
  const globalOverrideCount = stored.filter((s) => s.entityId === null).length;
  const scopeName = entityId ? ctx.entities.find((e) => e.id === entityId)?.name : null;

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Administration", href: "/admin" }, { label: "Business rules" }]} />

      <PageHeader
        eyebrow="Administration"
        title="Business rules"
        subtitle="Every threshold, limit and control switch the engine reads. Values resolve entity-specific first, then global, then the shipped default — nothing is hard-coded."
      />

      <div className="card flex flex-row flex-wrap items-end gap-3 px-3.5 py-3">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-[14rem]">
            <span className="label mb-1 block">Viewing rules for</span>
            <select className="field" name="entity" defaultValue={entityId ?? ""}>
              <option value="">Global — the value every entity inherits</option>
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

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Rules defined" value={CONFIG_DEFS.length} />
        <StatTile label="Global overrides" value={globalOverrideCount} hint="Changed from the shipped default" />
        <StatTile label="Entity overrides" value={entityOverrideCount} hint="Differ from the global value" />
        <StatTile label="Scope in view" value={scopeName ?? "Global"} />
      </div>

      {entityId ? (
        <InlineAlert tone="info">
          Showing the values {scopeName} actually uses. Where no entity override exists, the global value applies —
          setting one here affects this entity only.
        </InlineAlert>
      ) : (
        <InlineAlert tone="info">
          Showing global values. An entity can override any of these; pick an entity above to see and set its own values.
        </InlineAlert>
      )}

      {groups.map((group) => {
        const rows = effective.filter((e) => e.def.group === group);
        return (
          <SectionCard key={group} title={group} bodyClassName="px-0 py-0">
            <div className="table-wrap">
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ minWidth: "20rem" }}>Rule</th>
                    <th style={{ width: "12rem" }}>Value in force</th>
                    <th style={{ width: "11rem" }}>Source</th>
                    <th style={{ width: "11rem" }}>Shipped default</th>
                    <th style={{ width: "14rem" }}>Last changed</th>
                    <th style={{ width: "12rem" }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ def, value, globalOverride, entityOverride }) => {
                    const source = entityOverride
                      ? "Entity override"
                      : globalOverride
                        ? "Global override"
                        : "Shipped default";
                    const record = entityOverride ?? globalOverride;
                    const differsFromDefault = JSON.stringify(value) !== JSON.stringify(def.default);
                    return (
                      <tr key={def.key}>
                        <td>
                          <span className="block text-xs font-500">{def.label}</span>
                          <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{def.key}</span>
                          <span className="mt-1 block max-w-[34rem] text-2xs leading-4 text-muted">
                            {def.description}
                          </span>
                        </td>
                        <td>
                          <span className="tnum text-xs font-600">{display(value, def.valueType)}</span>
                        </td>
                        <td>
                          <Badge
                            tone={
                              entityOverride ? "warning" : globalOverride ? "info" : differsFromDefault ? "warning" : "neutral"
                            }
                          >
                            {source}
                          </Badge>
                        </td>
                        <td className="text-2xs text-muted">
                          {display(def.default, def.valueType)}
                        </td>
                        <td className="text-2xs">
                          {record ? (
                            <>
                              <span className="block">{fmtDateTime(record.updatedAt)}</span>
                              <span className="block text-[var(--c-text-tertiary)]">
                                {record.updatedBy ? (actorName.get(record.updatedBy) ?? "Unknown") : "Seed"}
                              </span>
                            </>
                          ) : (
                            <span className="text-[var(--c-text-tertiary)]">Never changed</span>
                          )}
                        </td>
                        <td>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <ConfigForm
                              configKey={def.key}
                              label={def.label}
                              description={def.description}
                              valueType={def.valueType}
                              currentValue={value}
                              defaultValue={def.default}
                              entities={ctx.entities}
                              entityId={entityId}
                              hasOverride={!!(entityOverride ?? globalOverride)}
                            />
                            {(entityId ? entityOverride : globalOverride) && (
                              <ActionButton
                                action={resetConfigAction}
                                payload={{ key: def.key, entityId: entityId ?? undefined }}
                                label="Reset"
                                tone="secondary"
                                size="xs"
                                confirm={
                                  entityId
                                    ? `Remove the entity override for "${def.label}"? It will follow the global value.`
                                    : `Remove the global override for "${def.label}"? It will follow the shipped default.`
                                }
                                reasonLabel="Why is this override being removed?"
                              />
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </SectionCard>
        );
      })}

      <SectionCard
        title="Every override on record"
        description="Both global and entity-level, with who changed them. This is the answer to 'why did the threshold change?'"
        bodyClassName="px-0 py-0"
      >
        {stored.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted">
            No overrides — every rule is running on its shipped default.
          </p>
        ) : (
          <div className="table-wrap max-h-[24rem] overflow-y-auto">
            <table className="dt">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Scope</th>
                  <th>Value</th>
                  <th>Changed by</th>
                  <th>Changed at</th>
                </tr>
              </thead>
              <tbody>
                {stored.map((s) => {
                  const def = CONFIG_DEFS.find((d) => d.key === s.key);
                  const entity = s.entityId ? ctx.entities.find((e) => e.id === s.entityId) : null;
                  let parsed: unknown = s.value;
                  try {
                    parsed = JSON.parse(s.value);
                  } catch {
                    /* stored as raw text */
                  }
                  return (
                    <tr key={s.id}>
                      <td>
                        <span className="block text-xs">{def?.label ?? s.key}</span>
                        <span className="mono mt-0.5 block text-2xs text-[var(--c-text-tertiary)]">{s.key}</span>
                      </td>
                      <td>
                        {entity ? (
                          <Badge tone="warning">{entity.code}</Badge>
                        ) : s.entityId ? (
                          <Badge tone="neutral">Other entity</Badge>
                        ) : (
                          <Badge tone="info">Global</Badge>
                        )}
                      </td>
                      <td className="text-xs">
                        <Mono>{display(parsed, def?.valueType ?? "string")}</Mono>
                      </td>
                      <td className="text-xs">
                        {s.updatedBy ? (actorName.get(s.updatedBy) ?? "Unknown") : "Seed"}
                      </td>
                      <td className="text-xs">{fmtDateTime(s.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
