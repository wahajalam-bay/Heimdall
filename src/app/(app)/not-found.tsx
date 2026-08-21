import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui/primitives";

export const metadata = { title: "Not found" };

/**
 * Reached when a record has been cancelled, superseded or never existed — the
 * 26 detail pages that call `notFound()` all land here. It stays inside the
 * application shell so the navigation is still there to carry on with.
 */
export default function NotFound() {
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Not found"
        title="That record is not here"
        subtitle="The link may be out of date, the document may have been cancelled, or it may belong to an entity you do not have access to."
      />
      <div className="card">
        <EmptyState
          title="Nothing to show at this address"
          description="Search for the document number in the top bar, or pick up from one of the registers below."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Link href="/" className="btn btn-primary btn-sm">
                Executive dashboard
              </Link>
              <Link href="/workspace" className="btn btn-secondary btn-sm">
                My workspace
              </Link>
              <Link href="/pr" className="btn btn-ghost btn-sm">
                Requisitions
              </Link>
              <Link href="/po" className="btn btn-ghost btn-sm">
                Purchase orders
              </Link>
            </div>
          }
        />
      </div>
    </div>
  );
}
