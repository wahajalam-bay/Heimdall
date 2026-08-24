import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/");

  // Demo directory so the system is usable immediately after seeding.
  const demoUsers = await prisma.user.findMany({
    where: { active: true },
    orderBy: [{ name: "asc" }],
    select: {
      email: true,
      name: true,
      title: true,
      primaryEntity: { select: { code: true } },
      roles: { select: { role: { select: { name: true, rank: true } } } },
    },
  });

  const accounts = demoUsers
    .map((u) => ({
      email: u.email,
      name: u.name,
      title: u.title,
      entity: u.primaryEntity?.code ?? "—",
      role: [...u.roles].sort((a, b) => b.role.rank - a.role.rank)[0]?.role.name ?? "—",
      rank: Math.max(0, ...u.roles.map((r) => r.role.rank)),
    }))
    .sort((a, b) => b.rank - a.rank);

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_28rem]">
      {/* Brand / context panel */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-surface p-10 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.55]"
          style={{
            background:
              "radial-gradient(60rem 40rem at 15% -10%, var(--c-accent-soft), transparent 60%), radial-gradient(40rem 30rem at 95% 105%, var(--c-progress-soft), transparent 60%)",
          }}
        />
        <div className="relative">
          <div className="flex items-center gap-2.5">
            <span
              className="flex size-8 items-center justify-center rounded-xl text-sm font-700 text-white"
              style={{ background: "var(--c-accent)" }}
            >
              H
            </span>
            <div>
              <p className="text-[0.9375rem] font-600 leading-5">Heimdall</p>
              <p className="text-xs text-[var(--c-text-tertiary)]">Supply Chain Operating System</p>
            </div>
          </div>
        </div>

        <div className="relative max-w-xl">
          <h1 className="text-[1.75rem] leading-9 font-600 tracking-[-0.02em]">
            One connected lifecycle, from requisition to finance handoff.
          </h1>
          <p className="mt-3 text-[0.875rem] leading-6 text-muted">
            Every requisition, RFQ, comparative, committee decision, purchase order, gate pass,
            inspection, GRN, inventory movement and invoice match lives in one auditable chain — with
            configurable thresholds per entity, not hard-coded rules.
          </p>
          <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-5">
            {[
              ["Requisition → Closure", "16 tracked lifecycle states with full audit"],
              ["Configurable governance", "CPC, petty cash and approval thresholds per entity"],
              ["Three-way matching", "PO + GRN + Invoice, blocked on mismatch"],
              ["Vendor governance", "Pre-qualification, performance, investigation, blacklist"],
            ].map(([t, d]) => (
              <div key={t}>
                <dt className="text-[0.8125rem] font-600">{t}</dt>
                <dd className="mt-0.5 text-xs leading-5 text-muted">{d}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="relative text-2xs text-[var(--c-text-tertiary)]">
          Internal system. Access is logged and audited.
        </p>
      </div>

      {/* Form panel */}
      <div className="flex flex-col justify-center bg-[var(--c-canvas)] px-5 py-10 sm:px-10">
        <div className="card card-pad mx-auto w-full max-w-sm gap-0">
          <div className="mb-6 lg:hidden">
            <span
              className="inline-flex size-8 items-center justify-center rounded-xl text-sm font-700 text-white"
              style={{ background: "var(--c-accent)" }}
            >
              H
            </span>
          </div>
          <h2 className="text-[1.25rem] font-600 tracking-[-0.015em]">Sign in</h2>
          <p className="mt-1 text-[0.8125rem] text-muted">
            Use your organisational credentials to continue.
          </p>
          <LoginForm accounts={accounts} />
        </div>
      </div>
    </div>
  );
}
