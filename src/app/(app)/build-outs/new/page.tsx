import { prisma } from "@/lib/db";
import { pageContext } from "@/lib/page";
import { PERMISSIONS as P } from "@/lib/permissions";
import { visibleEntityIds } from "@/lib/rbac";
import { AccessDenied } from "@/components/ui/guard";
import { Breadcrumbs } from "@/components/ui/nav";
import { InlineAlert, PageHeader } from "@/components/ui/primitives";
import { NewBuildOutForm } from "./NewBuildOutForm";
import { CHECKLIST_COUNT } from "@/server/buildout-checklist";

export const metadata = { title: "Raise a build-out" };
export const dynamic = "force-dynamic";

export default async function NewBuildOutPage() {
  const { ctx, authorized } = await pageContext(P.BUILD_OUT_CREATE);
  if (!authorized) return <AccessDenied title="Raise a build-out" />;

  const entityIds = visibleEntityIds(ctx.user);
  const [entities, projects, sites] = await Promise.all([
    prisma.entity.findMany({
      where: entityIds ? { id: { in: entityIds } } : {},
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.project.findMany({
      where: {
        ...(entityIds ? { entityId: { in: entityIds } } : {}),
        status: { notIn: ["CLOSED", "CANCELLED"] },
      },
      select: { id: true, code: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.site.findMany({
      where: { active: true, ...(entityIds ? { entityId: { in: entityIds } } : {}) },
      select: { id: true, code: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Build-outs", href: "/build-outs" }, { label: "New" }]} />
      <PageHeader
        eyebrow="Build-outs"
        title="Raise a build-out"
        subtitle="This records the intent. Nothing else can start until management gives the go-ahead — that is the first step of the SOP, and it is a decision by somebody other than whoever raises this."
      />

      <InlineAlert tone="info">
        Once the committee is convened, the {CHECKLIST_COUNT} responsibilities from the Checklist of Roles &amp;
        Responsibilities are copied onto this project across ten departments. You do not need to build a task list —
        the document is the task list.
      </InlineAlert>

      <NewBuildOutForm
        entities={entities}
        projects={projects}
        sites={sites}
        defaultEntityId={ctx.entityId ?? entities[0]?.id ?? ""}
      />
    </div>
  );
}
