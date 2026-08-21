import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getAppContext } from "@/lib/context";
import { navBadgeCounts } from "@/lib/counts";
import { visibleNav } from "@/lib/navigation";
import { prisma } from "@/lib/db";
import { DENSITY_COOKIE, isDensity, NAV_COOKIE } from "@/lib/nav-state";
import { Shortcuts } from "@/components/shell/Shortcuts";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const [ctx, counts, notifications] = await Promise.all([
    getAppContext(user),
    navBadgeCounts(user),
    prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: [{ read: "asc" }, { createdAt: "desc" }],
      take: 25,
    }),
  ]);

  const groups = visibleNav(user.permissions);
  const jar = await cookies();
  const rail = jar.get(NAV_COOKIE)?.value === "rail";
  const storedDensity = jar.get(DENSITY_COOKIE)?.value;
  const density = isDensity(storedDensity) ? storedDensity : "comfortable";

  return (
    <div className="min-h-dvh">
      <a href="#content" className="skip-link">
        Skip to content
      </a>
      <Sidebar
        groups={groups}
        counts={counts}
        initialRail={rail}
        entityLabel={ctx.entityName ? `${ctx.entityCode} · ${ctx.entityName}` : "All entities"}
      />
      <div className="transition-[padding] duration-150 ease-out lg:pl-[var(--nav-w)]">
        <Topbar
          user={{ name: user.name, email: user.email, title: user.title, roleNames: user.roleNames }}
          notifications={notifications.map((n) => ({
            id: n.id,
            type: n.type,
            title: n.title,
            body: n.body,
            priority: n.priority,
            linkUrl: n.linkUrl,
            read: n.read,
            createdAt: n.createdAt.toISOString(),
          }))}
          unreadCount={notifications.filter((n) => !n.read).length}
          entities={ctx.entities}
          activeEntityId={ctx.entityId}
          density={density}
        />
        <main id="content" className="mx-auto max-w-[110rem] px-3 py-4 sm:px-5 sm:py-6">
          {children}
        </main>
      </div>
      <Shortcuts />
    </div>
  );
}
