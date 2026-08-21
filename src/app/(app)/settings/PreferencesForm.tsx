"use client";

import { ActionForm } from "@/components/ui/forms";
import { Checkbox } from "@/components/ui/field";
import { humanize } from "@/lib/domain";
import { saveNotificationPreferences } from "./actions";

/** Notification preferences. In-app delivery is what the notification centre reads. */
export function NotificationPreferencesForm({
  initial,
  counts,
}: {
  initial: { notifyInApp: boolean; notifyEmail: boolean; notifyDigest: boolean };
  counts: Array<{ type: string; count: number }>;
}) {
  return (
    <ActionForm
      action={saveNotificationPreferences}
      submitLabel="Save preferences"
      successMessage="Preferences saved."
      layout="card"
    >
      <div>
        <h3 className="text-[0.875rem] font-600">Notification preferences</h3>
        <p className="mt-0.5 text-xs leading-5 text-[var(--c-text-secondary)]">
          Control how the system reaches you. Approval requests and blocking exceptions are always recorded against your
          workspace regardless of these settings, so nothing is ever lost.
        </p>
      </div>

      <div className="space-y-3">
        <Checkbox
          name="notifyInApp"
          label="In-app notifications"
          hint="Show alerts in the notification centre and on your workspace."
          defaultChecked={initial.notifyInApp}
        />
        <Checkbox
          name="notifyEmail"
          label="Email notifications"
          hint="Queue an email alongside each in-app notification where an email relay is configured."
          defaultChecked={initial.notifyEmail}
        />
        <Checkbox
          name="notifyDigest"
          label="Daily digest"
          hint="A once-daily summary of everything outstanding rather than an alert per event."
          defaultChecked={initial.notifyDigest}
        />
      </div>

      {counts.length > 0 && (
        <div className="border-t border-[var(--c-border-subtle)] pt-3.5">
          <h4 className="label mb-2">Notifications received to date</h4>
          <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {counts
              .sort((a, b) => b.count - a.count)
              .map((c) => (
                <li key={c.type} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-[var(--c-text-secondary)]">{humanize(c.type)}</span>
                  <span className="tnum font-500">{c.count}</span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </ActionForm>
  );
}
