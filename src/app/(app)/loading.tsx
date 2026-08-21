import { SkeletonTable, SkeletonTiles } from "@/components/ui/primitives";

/**
 * Shown while a page's data is being fetched.
 *
 * Every screen here is server-rendered against the database, so without this the
 * browser sits on the previous page with no sign that anything is happening. The
 * shapes match the rhythm most pages use — heading, summary tiles, table — so the
 * real content lands where the placeholder was rather than jumping.
 */
export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="skeleton h-2.5 w-24" />
          <div className="skeleton mt-2.5 h-6 w-[min(22rem,60%)]" />
          <div className="skeleton mt-2.5 h-3 w-[min(34rem,85%)]" />
        </div>
        <div className="flex shrink-0 gap-2">
          <div className="skeleton h-7 w-24" />
        </div>
      </header>

      <SkeletonTiles />
      <SkeletonTable rows={9} cols={7} />
    </div>
  );
}
