import { RuleViolationError } from "./errors";
import type { ProcurementType } from "./domain";

/**
 * Goods and services are two different procurements, not one with a flag.
 *
 * They diverge after the order is issued and never rejoin. Goods pass a gate,
 * get delivered, get inspected, become a receipt, become stock or an asset, and
 * only then can be invoiced. A service is performed, and somebody who wanted it
 * says whether it was done. Pushing a service through the goods path produces a
 * fiction — a delivery note for an oil test, stock on a shelf that holds nothing.
 *
 * The system already had `procurementType`, but it mixes cadence with kind:
 * `SERVICE` sits there beside `ON_DEMAND` and `MONTHLY_RECURRING`, so a monthly
 * requisition for grocery and a monthly requisition for office cleaning were
 * indistinguishable. `procurementKind` is orthogonal and says only which of the
 * two treatments applies.
 */

export const PROCUREMENT_KINDS = ["GOODS", "SERVICES"] as const;
export type ProcurementKind = (typeof PROCUREMENT_KINDS)[number];

export const PROCUREMENT_KIND_LABELS: Record<ProcurementKind, string> = {
  GOODS: "Goods",
  SERVICES: "Services",
};

export function isProcurementKind(v: unknown): v is ProcurementKind {
  return v === "GOODS" || v === "SERVICES";
}

/**
 * The kind implied by an existing `procurementType`, for records written before
 * the classification existed.
 *
 * `SERVICE` is unambiguous. `MATERIAL_DEMAND` is goods by definition — it is the
 * construction material route. The other two carry no signal at all, which is
 * the reason the new field exists, so they default to goods: that is what the
 * overwhelming majority of them are, and a wrong default on a service is caught
 * the moment somebody tries to receive it into stock.
 */
export function kindFromProcurementType(t: ProcurementType | string): ProcurementKind {
  return t === "SERVICE" ? "SERVICES" : "GOODS";
}

/** Goods enter stock and can be assets. A service can be neither. */
export function kindAllowsInventory(kind: ProcurementKind): boolean {
  return kind === "GOODS";
}

/**
 * Refuses a document whose lines are not all the same kind.
 *
 * This is the rule the brief states as "a Goods PO must not silently contain
 * Services". Silently is the operative word: the mixed document is not
 * corrected, it is refused, and the caller is told to raise two.
 */
export function assertHomogeneousKind(
  documentKind: ProcurementKind,
  lines: ReadonlyArray<{ lineNo?: number; description?: string; procurementKind?: string | null }>,
  what: string,
): void {
  const wrong = lines.filter(
    (l) => l.procurementKind && l.procurementKind !== documentKind,
  );
  if (!wrong.length) return;

  const listed = wrong
    .slice(0, 4)
    .map((l) => `line ${l.lineNo ?? "?"}${l.description ? ` (${l.description})` : ""}`)
    .join(", ");
  const more = wrong.length > 4 ? ` and ${wrong.length - 4} more` : "";
  const other = documentKind === "GOODS" ? "services" : "goods";

  throw new RuleViolationError(
    `${what} is a ${PROCUREMENT_KIND_LABELS[documentKind].toLowerCase()} document, but ${listed}${more} ${wrong.length === 1 ? "is" : "are"} ${other}. ` +
      `Goods and services follow different routes after the order — goods are received and inspected, services are accepted by the requesting department — so they need separate documents. ` +
      `Raise a second ${other} document and link the two to the same business need.`,
  );
}

/**
 * The kind a set of lines actually is, or null when they disagree.
 *
 * Used when creating a document from lines that already carry a kind, so the
 * document's own classification is derived from its contents rather than
 * asserted separately and allowed to drift.
 */
export function kindOfLines(
  lines: ReadonlyArray<{ procurementKind?: string | null }>,
): ProcurementKind | null {
  const kinds = new Set(
    lines.map((l) => l.procurementKind).filter(isProcurementKind),
  );
  if (kinds.size === 1) return [...kinds][0];
  return null;
}
