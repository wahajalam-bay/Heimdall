import type { ReactNode } from "react";
import { PageHeader, UnauthorizedState } from "./primitives";

/** Renders a page-level access-denied surface with consistent chrome. */
export function AccessDenied({
  title,
  message,
}: {
  title: string;
  message?: string;
}) {
  return (
    <div className="space-y-5">
      <PageHeader title={title} />
      <UnauthorizedState message={message} />
    </div>
  );
}

export function PermissionGate({
  allowed,
  fallback,
  children,
}: {
  allowed: boolean;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  if (!allowed) return <>{fallback ?? null}</>;
  return <>{children}</>;
}
