import { prisma } from "../../src/lib/db";

/**
 * Cleanup that survives a failing test.
 *
 * The verification scripts create real rows in the real database and delete them
 * at the end. When one throws halfway — which is exactly what a verification
 * script is for — the deletes never run, and the debris stays.
 *
 * That is not hypothetical. A test run that failed on a foreign-key error left
 * five purchase orders behind, four of them ISSUED with no approval, and the
 * data-integrity checker correctly failed on them the next time it ran. It was
 * right; the mess was mine.
 *
 * So cleanups register as they go and run in reverse in a `finally`, whether the
 * script passed, failed or threw. Each one is caught individually: a cleanup
 * that fails must not stop the ones behind it, or one stubborn foreign key
 * strands everything else.
 */
export type Cleanup = { label: string; run: () => Promise<unknown> };

export function fixtureScope() {
  const stack: Cleanup[] = [];

  return {
    /** Registers work to undo. Runs last-registered first. */
    onCleanup(label: string, run: () => Promise<unknown>) {
      stack.push({ label, run });
    },

    /**
     * Runs every registered cleanup, newest first, reporting what could not be
     * undone rather than swallowing it. Debris that cannot be removed is worth
     * knowing about — it is what the integrity checker will trip on.
     */
    async cleanup(): Promise<void> {
      const failures: string[] = [];
      for (const c of [...stack].reverse()) {
        try {
          await c.run();
        } catch (e) {
          failures.push(`${c.label}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      stack.length = 0;
      if (failures.length) {
        console.error(`\n${failures.length} cleanup step(s) failed — test data may be left behind:`);
        for (const f of failures) console.error(`  ${f}`);
      }
    },
  };
}

/**
 * Wraps a verification script so its cleanup always runs.
 *
 * Replaces the `main().catch(...).finally(...)` tail, and returns the right exit
 * code: a thrown error is a failure, and so is a script that recorded one.
 */
export async function runVerification(
  name: string,
  body: (scope: ReturnType<typeof fixtureScope>) => Promise<{ pass: number; fail: number }>,
): Promise<void> {
  const scope = fixtureScope();
  let result = { pass: 0, fail: 0 };
  let threw: unknown = null;
  try {
    result = await body(scope);
  } catch (e) {
    threw = e;
  } finally {
    await scope.cleanup();
    await prisma.$disconnect();
  }

  if (threw) {
    console.error(threw);
    console.log(`\n${name}: threw after ${result.pass} passing check(s).`);
    process.exit(1);
  }
  console.log(`\n${result.pass} passed, ${result.fail} failed`);
  if (result.fail) process.exitCode = 1;
}

/**
 * Sweeps up debris from runs that predate the scoped cleanups, or that were
 * killed rather than failed.
 *
 * Every fixture this repo creates is prefixed, so the sweep is exact rather than
 * heuristic — it never touches a row it did not create.
 */
export async function sweepTestDebris(): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  const count = (k: string, n: number) => {
    if (n) removed[k] = n;
  };

  const inspections = await prisma.inspection.findMany({
    where: { number: { startsWith: "TEST-" } },
    select: { id: true },
  });
  if (inspections.length) {
    const ids = inspections.map((i) => i.id);
    const returns = await prisma.vendorReturn.findMany({
      where: { inspectionId: { in: ids } },
      select: { id: true },
    });
    const rids = returns.map((r) => r.id);
    if (rids.length) {
      await prisma.auditLog.deleteMany({ where: { entityType: "VendorReturn", entityId: { in: rids } } });
      await prisma.vendorReturnItem.deleteMany({ where: { returnId: { in: rids } } });
      await prisma.vendorReturn.deleteMany({ where: { id: { in: rids } } });
      count("vendorReturns", rids.length);
    }
    await prisma.attestation.deleteMany({ where: { documentType: "INSPECTION", documentId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { entityType: "Inspection", entityId: { in: ids } } });
    await prisma.inspectionSignoff.deleteMany({ where: { inspectionId: { in: ids } } });
    await prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: ids } } });
    await prisma.inspection.deleteMany({ where: { id: { in: ids } } });
    count("inspections", ids.length);
  }

  const pos = await prisma.purchaseOrder.findMany({
    where: { number: { startsWith: "TEST-PO-" } },
    select: { id: true },
  });
  if (pos.length) {
    const ids = pos.map((p) => p.id);
    await prisma.auditLog.deleteMany({ where: { entityType: "PurchaseOrder", entityId: { in: ids } } });
    await prisma.purchaseOrderItem.deleteMany({ where: { poId: { in: ids } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: ids } } });
    count("purchaseOrders", ids.length);
  }

  const issues = await prisma.storeIssue.findMany({
    where: { number: { startsWith: "TEST-" } },
    select: { id: true },
  });
  if (issues.length) {
    const ids = issues.map((i) => i.id);
    await prisma.attestation.deleteMany({ where: { documentType: "STORE_ISSUE", documentId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { entityType: "StoreIssue", entityId: { in: ids } } });
    await prisma.storeIssueItem.deleteMany({ where: { issueId: { in: ids } } });
    await prisma.storeIssue.deleteMany({ where: { id: { in: ids } } });
    count("storeIssues", ids.length);
  }

  const wos = await prisma.workOrder.findMany({
    where: { number: { startsWith: "TEST-" } },
    select: { id: true },
  });
  if (wos.length) {
    const ids = wos.map((w) => w.id);
    await prisma.attestation.deleteMany({ where: { documentType: "WORK_ORDER", documentId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { entityType: "WorkOrder", entityId: { in: ids } } });
    await prisma.task.deleteMany({ where: { documentType: "WORK_ORDER", documentId: { in: ids } } });
    await prisma.workOrderItem.deleteMany({ where: { workOrderId: { in: ids } } });
    await prisma.workOrder.deleteMany({ where: { id: { in: ids } } });
    count("workOrders", ids.length);
  }

  const minutes = await prisma.negotiationMinute.findMany({
    where: { number: { startsWith: "TEST-" } },
    select: { id: true },
  });
  if (minutes.length) {
    const ids = minutes.map((m) => m.id);
    await prisma.attestation.deleteMany({
      where: { documentType: "NEGOTIATION_MINUTE", documentId: { in: ids } },
    });
    await prisma.auditLog.deleteMany({ where: { entityType: "NegotiationMinute", entityId: { in: ids } } });
    await prisma.negotiationBasisNote.deleteMany({ where: { minuteId: { in: ids } } });
    await prisma.negotiationParticipant.deleteMany({ where: { minuteId: { in: ids } } });
    await prisma.negotiationMinute.deleteMany({ where: { id: { in: ids } } });
    count("negotiationMinutes", ids.length);
  }

  const items = await prisma.item.findMany({
    where: {
      OR: [
        { sku: { startsWith: "FIFO-TEST-" } },
        { sku: { startsWith: "REPL-" } },
        { sku: { startsWith: "SLIP-" } },
      ],
    },
    select: { id: true },
  });
  if (items.length) {
    const ids = items.map((i) => i.id);
    const txns = await prisma.inventoryTransaction.findMany({
      where: { itemId: { in: ids } },
      select: { id: true },
    });
    await prisma.costLayerConsumption.deleteMany({ where: { layer: { itemId: { in: ids } } } });
    await prisma.costLayer.deleteMany({ where: { itemId: { in: ids } } });
    await prisma.auditLog.deleteMany({
      where: { entityType: "InventoryTransaction", entityId: { in: txns.map((t) => t.id) } },
    });
    await prisma.auditLog.deleteMany({ where: { entityType: "Item", entityId: { in: ids } } });
    await prisma.inventoryTransaction.deleteMany({ where: { itemId: { in: ids } } });
    await prisma.inventoryItem.deleteMany({ where: { itemId: { in: ids } } });
    await prisma.item.deleteMany({ where: { id: { in: ids } } });
    count("items", ids.length);
  }

  const vendors = await prisma.vendor.findMany({
    where: { code: { startsWith: "PQT-" } },
    select: { id: true },
  });
  if (vendors.length) {
    const ids = vendors.map((v) => v.id);
    await prisma.vendorEntityLink.deleteMany({ where: { vendorId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { entityType: "Vendor", entityId: { in: ids } } });
    await prisma.vendor.deleteMany({ where: { id: { in: ids } } });
    count("vendors", ids.length);
  }

  return removed;
}
