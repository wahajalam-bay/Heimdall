/**
 * Heimdall seed.
 *
 * Master data is written directly; every transactional flow is driven through
 * the real domain services so statuses, approvals, inventory, audit trail,
 * exceptions, tasks and notifications are all internally consistent — the same
 * code path the application uses.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  CATEGORIES,
  DEPARTMENTS,
  DOCUMENT_TYPES,
  ENTITIES,
  EVALUATION_CRITERIA,
  ITEMS,
  PROJECTS,
  SCORE_PROFILES,
  SITES,
  STORES,
  STORE_LOCATIONS,
  USERS,
  VENDORS,
} from "./seed-data";
import { ALL_PERMISSIONS, PERMISSION_META, ROLE_DEFINITIONS } from "../src/lib/permissions";
import { CONFIG_DEFS, CONFIG_KEYS, setConfig } from "../src/lib/config";
import type { SessionUser } from "../src/lib/rbac";

import { createPr, submitPr, decidePr, startSourcing, transitionPr } from "../src/server/pr";
import {
  buildComparative,
  createRfq,
  issueRfq,
  recommendVendor,
  recordNegotiation,
  upsertQuote,
  markVendorDeclined,
  closeRfq,
} from "../src/server/sourcing";
import { castCpcDecision, createCpcCase, cpcRequirement, ensureUpcomingMeeting } from "../src/server/cpc";
import { createPoFromCase, submitPoForApproval, decidePo, issuePo, closePo } from "../src/server/po";
import { createGatePass, recordDelivery, recordInspection, INSPECTION_TEMPLATES } from "../src/server/receiving";
import { createGrn, postGrn, recordStacking, sweepMissingGrns } from "../src/server/grn";
import {
  registerInvoice,
  verifyInvoice,
  submitInvoiceForApproval,
  decideInvoice,
  handoffToFinance,
  acknowledgeHandoff,
  recordPayment,
} from "../src/server/invoice";
import {
  createPettyCash,
  submitPettyCash,
  addPettyCashQuote,
  selectPettyCashQuote,
  approvePettyCash,
  recordPurchase,
  generateVoucher,
  signVoucher,
  completeStoreEntry,
  reconcilePettyCash,
  closePettyCash,
} from "../src/server/pettycash";
import {
  createStoreIssue,
  decideStoreIssue,
  issueStock,
  createTransfer,
  decideTransfer,
  dispatchTransfer,
  receiveTransfer,
} from "../src/server/stores";
import {
  evaluateVendor,
  decideVendorApproval,
  openBlacklistCase,
  advanceBlacklistCase,
  raiseVendorIssue,
  recomputeAllVendorPerformance,
} from "../src/server/vendors";
import { createDisposalCase, advanceDisposal, addDisposalBid, updateAsset } from "../src/server/assets";
import { recordSavingsForPo } from "../src/server/analytics";

const prisma = new PrismaClient();
const PASSWORD = "Passw0rd!";

const D = (daysAgo: number, hour = 10, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
};
const FUTURE = (days: number) => new Date(Date.now() + days * 86400000);

function log(section: string, detail?: string) {
  process.stdout.write(`  ${section}${detail ? ` — ${detail}` : ""}\n`);
}

// ── Lookup caches ────────────────────────────────────────────
const entityId: Record<string, string> = {};
const departmentId: Record<string, string> = {};
const projectId: Record<string, string> = {};
const siteId: Record<string, string> = {};
const storeId: Record<string, string> = {};
const locationId: Record<string, string> = {};
const categoryId: Record<string, string> = {};
const itemId: Record<string, string> = {};
const vendorId: Record<string, string> = {};
const users: Record<string, SessionUser> = {};

async function sessionFor(email: string): Promise<SessionUser> {
  const u = await prisma.user.findUniqueOrThrow({
    where: { email },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      entityAccess: true,
      primaryEntity: true,
      primaryDepartment: true,
    },
  });
  const perms = new Set<string>();
  for (const ur of u.roles) for (const rp of ur.role.permissions) perms.add(rp.permission.code);
  const eids = new Set(u.entityAccess.map((e) => e.entityId));
  if (u.primaryEntityId) eids.add(u.primaryEntityId);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    title: u.title,
    primaryEntityId: u.primaryEntityId,
    primaryDepartmentId: u.primaryDepartmentId,
    primaryEntityCode: u.primaryEntity?.code ?? null,
    primaryEntityName: u.primaryEntity?.name ?? null,
    primaryDepartmentName: u.primaryDepartment?.name ?? null,
    roleCodes: u.roles.map((r) => r.role.code),
    roleNames: u.roles.map((r) => r.role.name),
    permissions: [...perms],
    entityIds: [...eids],
  };
}

/** Shifts a case's audit trail (and key document dates) into the past. */
async function backdateCase(caseKey: string, daysAgo: number) {
  const shiftMs = daysAgo * 86400000;
  const logs = await prisma.auditLog.findMany({ where: { caseKey }, select: { id: true, createdAt: true } });
  for (const l of logs) {
    await prisma.auditLog.update({
      where: { id: l.id },
      data: { createdAt: new Date(l.createdAt.getTime() - shiftMs) },
    });
  }
  const pr = await prisma.purchaseRequisition.findUnique({ where: { number: caseKey } });
  if (!pr) return;
  const shift = (d: Date | null) => (d ? new Date(d.getTime() - shiftMs) : null);
  await prisma.purchaseRequisition.update({
    where: { id: pr.id },
    data: {
      createdAt: new Date(pr.createdAt.getTime() - shiftMs),
      submittedAt: shift(pr.submittedAt),
      approvedAt: shift(pr.approvedAt),
      closedAt: shift(pr.closedAt),
    },
  });
  const pos = await prisma.purchaseOrder.findMany({ where: { prId: pr.id } });
  for (const po of pos) {
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        createdAt: new Date(po.createdAt.getTime() - shiftMs),
        approvedAt: shift(po.approvedAt),
        issuedAt: shift(po.issuedAt),
        closedAt: shift(po.closedAt),
      },
    });
    const grns = await prisma.grn.findMany({ where: { poId: po.id } });
    for (const g of grns) {
      await prisma.grn.update({
        where: { id: g.id },
        data: {
          createdAt: new Date(g.createdAt.getTime() - shiftMs),
          receivedAt: new Date(g.receivedAt.getTime() - shiftMs),
          postedAt: shift(g.postedAt),
        },
      });
    }
    const invs = await prisma.invoice.findMany({ where: { poId: po.id } });
    for (const i of invs) {
      await prisma.invoice.update({
        where: { id: i.id },
        data: {
          createdAt: new Date(i.createdAt.getTime() - shiftMs),
          receivedDate: new Date(i.receivedDate.getTime() - shiftMs),
        },
      });
    }
  }
  const cmps = await prisma.comparative.findMany({ where: { prId: pr.id } });
  for (const c of cmps) {
    await prisma.comparative.update({
      where: { id: c.id },
      data: { preparedAt: new Date(c.preparedAt.getTime() - shiftMs) },
    });
  }
  const savings = await prisma.savingsRecord.findMany({ where: { poId: { in: pos.map((p) => p.id) } } });
  for (const s of savings) {
    await prisma.savingsRecord.update({
      where: { id: s.id },
      data: { recordedAt: new Date(s.recordedAt.getTime() - shiftMs) },
    });
  }
}

// ─────────────────────────────────────────────────────────────
// 1. Reset
// ─────────────────────────────────────────────────────────────
async function reset() {
  const tables = [
    "document_access_logs", "documents", "audit_logs", "notifications", "tasks", "exceptions",
    "savings_records", "saved_views", "sessions",
    "payment_handoffs", "invoice_grn_links", "invoice_items", "invoices",
    "petty_cash_vouchers", "petty_cash_quotes", "petty_cash_items",
    "inventory_transactions", "petty_cash_requests",
    "goods_stacking", "grn_items", "grns",
    "inspection_items", "inspections", "delivery_items", "deliveries", "gate_passes",
    "store_issue_items", "store_issues", "store_transfer_items", "store_transfers",
    "inventory",
    "asset_transactions", "disposal_bids", "disposal_items", "disposal_cases", "assets",
    "cpc_decisions", "cpc_case_members", "cpc_cases", "cpc_meetings",
    "comparative_lines", "comparatives", "negotiations", "quote_items", "vendor_quotes",
    "rfq_vendors", "rfqs",
    "purchase_order_items", "purchase_orders",
    "approval_actions", "approval_instances", "approval_rule_steps", "approval_rules",
    "purchase_requisition_items", "purchase_requisitions",
    "vendor_scores", "vendor_evaluations", "vendor_performance", "vendor_issues",
    "vendor_blacklist_cases", "vendor_documents", "vendor_contacts", "vendor_entity_links", "vendors",
    "evaluation_criteria", "price_history", "items", "categories",
    "store_locations", "stores", "sites", "projects",
    "config_settings", "document_types", "number_sequences",
    "user_roles", "role_permissions", "user_entity_access", "users",
    "departments", "entities", "permissions", "roles",
  ];
  for (const t of tables) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
  }
  log("Reset", `${tables.length} tables cleared`);
}

// ─────────────────────────────────────────────────────────────
// 2. RBAC
// ─────────────────────────────────────────────────────────────
async function seedRbac() {
  for (const code of ALL_PERMISSIONS) {
    const meta = PERMISSION_META[code] ?? { group: "General", name: code };
    await prisma.permission.create({ data: { code, name: meta.name, group: meta.group } });
  }
  const permMap = new Map((await prisma.permission.findMany()).map((p) => [p.code, p.id]));

  for (const r of ROLE_DEFINITIONS) {
    const role = await prisma.role.create({
      data: { code: r.code, name: r.name, description: r.description, rank: r.rank, isSystem: true },
    });
    const unique = [...new Set(r.permissions)];
    await prisma.rolePermission.createMany({
      data: unique
        .filter((p) => permMap.has(p))
        .map((p) => ({ roleId: role.id, permissionId: permMap.get(p)! })),
    });
  }
  log("RBAC", `${ALL_PERMISSIONS.length} permissions, ${ROLE_DEFINITIONS.length} roles`);
}

// ─────────────────────────────────────────────────────────────
// 3. Organisation
// ─────────────────────────────────────────────────────────────
async function seedOrg() {
  for (const e of ENTITIES) {
    const row = await prisma.entity.create({
      data: {
        code: e.code,
        name: e.name,
        legalName: e.legalName,
        city: e.city,
        address: e.address,
        taxNumber: e.taxNumber,
        logoText: e.logoText,
        currency: "PKR",
      },
    });
    entityId[e.code] = row.id;
  }
  for (const d of DEPARTMENTS) {
    const row = await prisma.department.create({
      data: { code: d.code, name: d.name, entityId: entityId[d.entity], costCenter: d.costCenter },
    });
    departmentId[`${d.entity}:${d.code}`] = row.id;
  }
  for (const p of PROJECTS) {
    const row = await prisma.project.create({
      data: {
        code: p.code,
        name: p.name,
        entityId: entityId[p.entity],
        city: p.city,
        budget: p.budget,
        status: p.status,
        startDate: D(420),
        endDate: FUTURE(540),
      },
    });
    projectId[p.code] = row.id;
  }
  for (const s of SITES) {
    const row = await prisma.site.create({
      data: {
        code: s.code,
        name: s.name,
        entityId: entityId[s.entity],
        projectId: projectId[s.project],
        city: s.city,
        address: s.address,
      },
    });
    siteId[s.code] = row.id;
  }
  for (const s of STORES) {
    const row = await prisma.store.create({
      data: {
        code: s.code,
        name: s.name,
        kind: s.kind,
        entityId: entityId[s.entity],
        siteId: s.site ? siteId[s.site] : null,
        projectId: s.project ? projectId[s.project] : null,
        city: s.city,
        address: s.address,
      },
    });
    storeId[s.code] = row.id;
  }
  for (const l of STORE_LOCATIONS) {
    const row = await prisma.storeLocation.create({
      data: {
        storeId: storeId[l.store],
        label: l.label,
        zone: l.zone,
        rack: l.rack,
        bin: l.bin,
        handling: l.handling,
      },
    });
    locationId[`${l.store}:${l.label}`] = row.id;
  }
  log("Organisation", `${ENTITIES.length} entities, ${DEPARTMENTS.length} departments, ${STORES.length} stores`);
}

// ─────────────────────────────────────────────────────────────
// 4. Catalogue
// ─────────────────────────────────────────────────────────────
async function seedCatalogue() {
  for (const c of CATEGORIES) {
    const row = await prisma.category.create({
      data: {
        code: c.code,
        name: c.name,
        requiresInspection: c.requiresInspection,
        defaultDisposition: c.defaultDisposition,
        assetTagRequired: c.assetTagRequired,
        entityId: c.entity ? entityId[c.entity] : null,
      },
    });
    categoryId[c.code] = row.id;
  }
  for (const i of ITEMS) {
    const row = await prisma.item.create({
      data: {
        sku: i.sku,
        name: i.name,
        categoryId: categoryId[i.category],
        unit: i.unit,
        brand: i.brand ?? null,
        model: i.model ?? null,
        make: i.make ?? null,
        specification: i.specification ?? null,
        standardPrice: i.standardPrice ?? null,
        trackSerial: Boolean(i.trackSerial),
        trackBatch: Boolean(i.trackBatch),
        trackExpiry: Boolean(i.trackExpiry),
        reorderLevel: i.reorderLevel ?? null,
      },
    });
    itemId[i.sku] = row.id;
  }
  for (const c of EVALUATION_CRITERIA) {
    await prisma.evaluationCriterion.create({
      data: { code: c.code, name: c.name, description: c.description, group: c.group, sequence: c.sequence, maxScore: 3, weight: 1 },
    });
  }
  for (const d of DOCUMENT_TYPES) {
    await prisma.documentType.create({
      data: {
        code: d.code,
        name: d.name,
        category: d.category,
        appliesTo: JSON.stringify(d.appliesTo),
        viewPermission: d.viewPermission ?? null,
        allowedExtensions: (d as { allowedExtensions?: string }).allowedExtensions ?? "pdf,png,jpg,jpeg,xlsx,xls,docx,doc,csv",
      },
    });
  }
  log("Catalogue", `${CATEGORIES.length} categories, ${ITEMS.length} items, ${EVALUATION_CRITERIA.length} criteria, ${DOCUMENT_TYPES.length} document types`);
}

// ─────────────────────────────────────────────────────────────
// 5. Users
// ─────────────────────────────────────────────────────────────
/** Roles whose work is time-critical enough to warrant email out of the box. */
const EMAIL_BY_DEFAULT = new Set([
  "HOD",
  "PROCUREMENT_DIRECTOR",
  "PROCUREMENT_SENIOR_MANAGER",
  "FINANCE_APPROVER",
  "MANAGEMENT_COMMITTEE",
]);

async function seedUsers() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const roleMap = new Map((await prisma.role.findMany()).map((r) => [r.code, r.id]));

  for (const u of USERS) {
    const row = await prisma.user.create({
      data: {
        email: u.email,
        name: u.name,
        title: u.title,
        phone: u.phone ?? null,
        passwordHash: hash,
        primaryEntityId: entityId[u.entity],
        primaryDepartmentId: u.department ? departmentId[`${u.entity}:${u.department}`] : null,
        roles: { create: u.roles.filter((r) => roleMap.has(r)).map((r) => ({ roleId: roleMap.get(r)! })) },
        // People who decide things get email as well as the in-app centre: an
        // approval waiting in a queue nobody has open is the case the notification
        // centre cannot cover. Everyone else opts in from Settings.
        notifyEmail: u.roles.some((r) => EMAIL_BY_DEFAULT.has(r)),
        entityAccess: {
          create: (u.entities ?? [u.entity]).map((e) => ({ entityId: entityId[e] })),
        },
      },
    });
    void row;
  }

  // Department heads
  const heads: Array<[string, string]> = [
    ["ZM:IT", "bilal.hameed@zameen.com"],
    ["ZM:MKT", "adeel.rauf@zameen.com"],
    ["ZM:ADMIN", "tahir.abbas@zameen.com"],
    ["ZM:SALES", "junaid.akhtar@zameen.com"],
    ["ZM:HR", "ayesha.malik@zameen.com"],
    ["ZM:FIN", "nadia.saleem@zameen.com"],
    ["ZM:SCM", "kamran.rasheed@zameen.com"],
    ["ZD:PROJ", "haroon.rashid@zameen.com"],
    ["ZD:DESIGN", "nauman.ashraf@zameen.com"],
    ["ZD:MEP", "kashif.mehmood@zameen.com"],
    ["ZD:SCM", "farhan.siddiqui@zameen.com"],
    ["ZD:ADMIN", "zd.admin@zameen.com"],
    ["ZD:FIN", "nadia.saleem@zameen.com"],
    ["ZD:QS", "arsalan.baig@zameen.com"],
  ];
  for (const [dept, email] of heads) {
    const u = await prisma.user.findUnique({ where: { email } });
    if (u && departmentId[dept]) {
      await prisma.department.update({ where: { id: departmentId[dept] }, data: { headId: u.id } });
    }
  }

  // Store managers
  const storeManagers: Array<[string, string]> = [
    ["WH-MULTAN", "iftikhar.hussain@zameen.com"],
    ["ST-OPL", "naveed.anjum@zameen.com"],
    ["ST-PRK", "ahsan.iqbal@zameen.com"],
    ["ST-RES", "shoaib.akram@zameen.com"],
    ["ST-ZM-HO", "shakeel.ahmad@zameen.com"],
    ["ST-ZM-IT", "shakeel.ahmad@zameen.com"],
    ["ST-ZM-KHI", "shakeel.ahmad@zameen.com"],
    ["ST-ZD-OFF", "zd.admin@zameen.com"],
  ];
  for (const [store, email] of storeManagers) {
    const u = await prisma.user.findUnique({ where: { email } });
    if (u && storeId[store]) {
      await prisma.store.update({ where: { id: storeId[store] }, data: { managerId: u.id } });
    }
  }

  // Project managers
  const pms: Array<[string, string]> = [
    ["ZD-OPL", "aliya.zafar@zameen.com"],
    ["ZD-PRK", "raza.hussain@zameen.com"],
    ["ZD-RES", "haroon.rashid@zameen.com"],
  ];
  for (const [proj, email] of pms) {
    const u = await prisma.user.findUnique({ where: { email } });
    if (u) await prisma.project.update({ where: { id: projectId[proj] }, data: { managerId: u.id } });
  }

  for (const u of USERS) users[u.email] = await sessionFor(u.email);
  log("Users", `${USERS.length} users across ${ROLE_DEFINITIONS.length} roles`);
}

// ─────────────────────────────────────────────────────────────
// 6. Configuration & approval rules
// ─────────────────────────────────────────────────────────────
async function seedConfig() {
  const admin = users["system.admin@zameen.com"];
  for (const def of CONFIG_DEFS) {
    await setConfig(def.key, def.default, null, admin.id, prisma);
  }
  // Entity-level overrides prove configuration is not global-only.
  await setConfig(CONFIG_KEYS.CPC_THRESHOLD, 750000, entityId.ZD, admin.id, prisma);
  await setConfig(CONFIG_KEYS.PETTY_CASH_LIMIT, 25000, entityId.ZD, admin.id, prisma);
  await setConfig(CONFIG_KEYS.ADVANCE_PAYMENT_ALLOWED, true, entityId.ZD, admin.id, prisma);
  await setConfig(CONFIG_KEYS.ADVANCE_MAX_PERCENT, 40, entityId.ZD, admin.id, prisma);
  await setConfig(CONFIG_KEYS.ADVANCE_PAYMENT_ALLOWED, false, entityId.ZM, admin.id, prisma);
  await setConfig(CONFIG_KEYS.MIN_QUOTATIONS, 3, entityId.ZD, admin.id, prisma);
  log("Configuration", `${CONFIG_DEFS.length} global settings + 6 entity overrides`);
}

async function seedApprovalRules() {
  const roleMap = new Map((await prisma.role.findMany()).map((r) => [r.code, r.id]));
  const R = (code: string) => roleMap.get(code) ?? null;

  type StepDef = {
    name: string;
    role?: string;
    approverType?: string;
    slaHours?: number;
    commentRequired?: boolean;
  };
  const rule = async (def: {
    code: string;
    name: string;
    description: string;
    documentType: string;
    entity?: "ZM" | "ZD";
    department?: string;
    procurementType?: string;
    minAmount?: number;
    maxAmount?: number | null;
    priority?: number;
    requiresCpc?: boolean;
    steps: StepDef[];
  }) => {
    const created = await prisma.approvalRule.create({
      data: {
        code: def.code,
        name: def.name,
        description: def.description,
        documentType: def.documentType,
        entityId: def.entity ? entityId[def.entity] : null,
        procurementType: def.procurementType ?? null,
        minAmount: def.minAmount ?? 0,
        maxAmount: def.maxAmount ?? null,
        priority: def.priority ?? 100,
        requiresCpc: def.requiresCpc ?? false,
        steps: {
          create: def.steps.map((s, i) => ({
            sequence: i + 1,
            name: s.name,
            roleId: s.role ? R(s.role) : null,
            approverType: s.approverType ?? (s.role ? "ROLE" : "DEPARTMENT_HEAD"),
            slaHours: s.slaHours ?? 24,
            commentRequired: s.commentRequired ?? false,
          })),
        },
      },
    });
    return created;
  };

  // ── Requisitions ──
  await rule({
    code: "PR-STD-LOW",
    name: "Requisition — up to PKR 100,000",
    description: "Department head approval only for routine low-value requisitions.",
    documentType: "PR",
    minAmount: 0,
    maxAmount: 99999.99,
    priority: 30,
    steps: [{ name: "Department Head Approval", approverType: "DEPARTMENT_HEAD", slaHours: 24 }],
  });
  await rule({
    code: "PR-STD-MID",
    name: "Requisition — PKR 100,000 to 500,000",
    description: "Department head then procurement senior manager review.",
    documentType: "PR",
    minAmount: 100000,
    maxAmount: 499999.99,
    priority: 30,
    steps: [
      { name: "Department Head Approval", approverType: "DEPARTMENT_HEAD", slaHours: 24 },
      { name: "Procurement Review", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 24 },
    ],
  });
  await rule({
    code: "PR-STD-HIGH",
    name: "Requisition — PKR 500,000 and above",
    description: "Department head, procurement senior manager and procurement director. CPC review applies before the purchase order.",
    documentType: "PR",
    minAmount: 500000,
    priority: 30,
    requiresCpc: true,
    steps: [
      { name: "Department Head Approval", approverType: "DEPARTMENT_HEAD", slaHours: 24 },
      { name: "Procurement Review", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 24 },
      { name: "Procurement Director Approval", role: "PROCUREMENT_DIRECTOR", slaHours: 48, commentRequired: false },
    ],
  });
  await rule({
    code: "PR-MONTHLY",
    name: "Monthly / recurring requisition",
    description: "Recurring consumables need department approval only, regardless of value.",
    documentType: "PR",
    procurementType: "MONTHLY_RECURRING",
    minAmount: 0,
    priority: 20,
    steps: [{ name: "Department Head Approval", approverType: "DEPARTMENT_HEAD", slaHours: 24 }],
  });

  // ── ZD Material Demand ──
  await rule({
    code: "MD-ZD-LOW",
    name: "ZD Material Demand — up to PKR 750,000",
    description: "Project director validates technically, then supply chain reviews.",
    documentType: "MATERIAL_DEMAND",
    entity: "ZD",
    minAmount: 0,
    maxAmount: 749999.99,
    priority: 10,
    steps: [
      { name: "Technical Validation (Projects)", approverType: "DEPARTMENT_HEAD", slaHours: 24 },
      { name: "Supply Chain Review", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 24 },
    ],
  });
  await rule({
    code: "MD-ZD-HIGH",
    name: "ZD Material Demand — PKR 750,000 and above",
    description: "Technical validation, supply chain review and procurement director. CPC review applies before the purchase order.",
    documentType: "MATERIAL_DEMAND",
    entity: "ZD",
    minAmount: 750000,
    priority: 10,
    requiresCpc: true,
    steps: [
      { name: "Technical Validation (Projects)", approverType: "DEPARTMENT_HEAD", slaHours: 24 },
      { name: "Supply Chain Review", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 24 },
      { name: "Procurement Director Approval", role: "PROCUREMENT_DIRECTOR", slaHours: 48 },
    ],
  });
  await rule({
    code: "MD-ZD-FALLBACK",
    name: "Material Demand — general",
    description: "Fallback chain for Material Demands raised outside ZD.",
    documentType: "MATERIAL_DEMAND",
    minAmount: 0,
    priority: 90,
    steps: [
      { name: "Technical Validation", approverType: "DEPARTMENT_HEAD", slaHours: 24 },
      { name: "Supply Chain Review", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 24 },
    ],
  });

  // ── Purchase orders ──
  await rule({
    code: "PO-LOW",
    name: "Purchase order — up to PKR 100,000",
    description: "Procurement senior manager authorisation.",
    documentType: "PO",
    minAmount: 0,
    maxAmount: 99999.99,
    priority: 30,
    steps: [{ name: "Procurement Senior Manager Approval", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 24 }],
  });
  await rule({
    code: "PO-MID",
    name: "Purchase order — PKR 100,000 to 500,000",
    description: "Procurement senior manager then procurement director.",
    documentType: "PO",
    minAmount: 100000,
    maxAmount: 499999.99,
    priority: 30,
    steps: [
      { name: "Procurement Senior Manager Approval", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 24 },
      { name: "Procurement Director Approval", role: "PROCUREMENT_DIRECTOR", slaHours: 24 },
    ],
  });
  await rule({
    code: "PO-HIGH",
    name: "Purchase order — PKR 500,000 and above",
    description: "Procurement senior manager, procurement director and finance approver.",
    documentType: "PO",
    minAmount: 500000,
    priority: 30,
    steps: [
      { name: "Procurement Senior Manager Approval", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 24 },
      { name: "Procurement Director Approval", role: "PROCUREMENT_DIRECTOR", slaHours: 24 },
      { name: "Finance Approval", role: "FINANCE_APPROVER", slaHours: 48 },
    ],
  });

  // ── Invoices ──
  await rule({
    code: "INV-LOW",
    name: "Invoice — up to PKR 100,000",
    description: "Procurement verification is sufficient below the threshold.",
    documentType: "INVOICE",
    minAmount: 0,
    maxAmount: 99999.99,
    priority: 30,
    steps: [{ name: "Procurement Senior Manager Approval", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 48 }],
  });
  await rule({
    code: "INV-MID",
    name: "Invoice — PKR 100,000 to 500,000",
    description: "Procurement senior manager then procurement director.",
    documentType: "INVOICE",
    minAmount: 100000,
    maxAmount: 499999.99,
    priority: 30,
    steps: [
      { name: "Procurement Senior Manager Approval", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 48 },
      { name: "Procurement Director Approval", role: "PROCUREMENT_DIRECTOR", slaHours: 48 },
    ],
  });
  await rule({
    code: "INV-HIGH",
    name: "Invoice — PKR 500,000 and above",
    description: "Procurement senior manager, procurement director and finance approver before payment.",
    documentType: "INVOICE",
    minAmount: 500000,
    priority: 30,
    steps: [
      { name: "Procurement Senior Manager Approval", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 48 },
      { name: "Procurement Director Approval", role: "PROCUREMENT_DIRECTOR", slaHours: 48 },
      { name: "Finance Approval", role: "FINANCE_APPROVER", slaHours: 48 },
    ],
  });

  // ── Petty cash, disposal, transfers ──
  await rule({
    code: "PC-STD",
    name: "Petty cash purchase",
    description: "Procurement senior manager authorises the cash purchase.",
    documentType: "PETTY_CASH",
    minAmount: 0,
    priority: 30,
    steps: [{ name: "Cash Purchase Approval", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 24 }],
  });
  await rule({
    code: "DISP-STD",
    name: "Asset disposal",
    description: "Audit review, procurement approval, then management committee sign-off.",
    documentType: "DISPOSAL",
    minAmount: 0,
    priority: 30,
    steps: [
      { name: "Audit Review", role: "AUDIT_USER", slaHours: 72 },
      { name: "Procurement Approval", role: "PROCUREMENT_SENIOR_MANAGER", slaHours: 72 },
      { name: "Management Committee Approval", role: "MANAGEMENT_COMMITTEE", slaHours: 120 },
    ],
  });
  await rule({
    code: "TRF-STD",
    name: "Store transfer",
    description: "Warehouse manager authorises inter-store movement.",
    documentType: "STORE_TRANSFER",
    minAmount: 0,
    priority: 30,
    steps: [{ name: "Warehouse Manager Approval", role: "WAREHOUSE_MANAGER", slaHours: 24 }],
  });

  const count = await prisma.approvalRule.count();
  log("Approval rules", `${count} configurable rules`);
}

// ─────────────────────────────────────────────────────────────
// 7. Vendors
// ─────────────────────────────────────────────────────────────
async function seedVendors() {
  const officer = users["hira.aslam@zameen.com"];
  const zdOfficer = users["danish.raza@zameen.com"];
  const approver = users["asim.javed@zameen.com"];
  const criteria = await prisma.evaluationCriterion.findMany({ orderBy: { sequence: "asc" } });

  for (const [idx, v] of VENDORS.entries()) {
    const created = await prisma.vendor.create({
      data: {
        code: `V-${String(idx + 1).padStart(4, "0")}`,
        name: v.name,
        legalName: v.legalName,
        businessType: v.businessType,
        address: v.address,
        city: v.city,
        contactPerson: v.contactPerson,
        contactPhone: v.contactPhone,
        contactEmail: v.contactEmail,
        taxStatus: v.taxStatus,
        ntn: v.ntn,
        strn: v.strn ?? null,
        officeCount: v.officeCount,
        citiesCovered: v.citiesCovered,
        workforceCount: v.workforceCount,
        hasTransportation: v.hasTransportation,
        supportStaffCount: v.supportStaffCount ?? null,
        paymentTerms: v.paymentTerms,
        creditDays: v.creditDays,
        bankName: v.bankName,
        bankAccountTitle: v.bankAccountTitle,
        bankAccountNumber: v.bankAccountNumber,
        references: v.references ?? null,
        productsServices: v.productsServices,
        categories: v.categories,
        sourceChannel: v.sourceChannel,
        isTrader: Boolean(v.isTrader),
        minimumOrderValue: v.minimumOrderValue ?? null,
        status: "PROSPECT",
        contacts: {
          create: [
            { name: v.contactPerson, role: "Primary contact", phone: v.contactPhone, email: v.contactEmail, isPrimary: true },
          ],
        },
        entityLinks: { create: v.entities.map((e) => ({ entityId: entityId[e], approved: false })) },
        documents: {
          create: [
            { docType: "COMPANY_PROFILE", name: `${v.name} — company profile`, verified: true },
            { docType: "NTN_CERTIFICATE", name: `NTN ${v.ntn}`, verified: true },
            ...(v.strn ? [{ docType: "STRN_CERTIFICATE", name: `STRN ${v.strn}`, verified: true }] : []),
            { docType: "BANK_LETTER", name: `${v.bankName} account letter`, verified: true },
          ],
        },
      },
    });
    vendorId[v.name] = created.id;

    // Pre-qualification scoring for everything past prospect stage.
    if (v.status !== "PROSPECT") {
      const evaluator = v.entities.includes("ZD") && !v.entities.includes("ZM") ? zdOfficer : officer;
      const scoreFn = SCORE_PROFILES[v.scoreProfile];
      await evaluateVendor(
        evaluator,
        {
          vendorId: created.id,
          scores: criteria.map((c) => ({
            criterionId: c.id,
            score: scoreFn(c.sequence),
            comment: null,
          })),
          recommendation:
            v.scoreProfile === "weak"
              ? "Marginal capability. Recommend conditional approval for low-value, quick-turnaround requirements only."
              : `Meets pre-qualification requirements for ${v.categories}.`,
          notes: `Sourced via ${v.sourceChannel.toLowerCase()}. ${v.officeCount} office(s), ${v.workforceCount} staff, transport ${v.hasTransportation ? "available" : "not available"}.`,
          entityId: entityId[v.entities[0]],
          submit: v.status !== "UNDER_EVALUATION",
        },
        prisma,
      );
    }

    if (v.status === "APPROVED") {
      await decideVendorApproval(
        approver,
        {
          vendorId: created.id,
          decision: "APPROVE",
          reason: `Pre-qualification passed. Approved for ${v.categories} in ${v.entities.join(", ")}.`,
          entityIds: v.entities.map((e) => entityId[e]),
        },
        prisma,
      );
    } else if (v.status === "CONDITIONAL") {
      await decideVendorApproval(
        approver,
        {
          vendorId: created.id,
          decision: "CONDITIONAL",
          reason:
            "Score below the standard minimum but retained as a trader for small-quantity requirements below principal-vendor MOQ. Cash/advance terms only.",
          entityIds: v.entities.map((e) => entityId[e]),
        },
        prisma,
      );
    } else if (v.status === "BLACKLISTED") {
      // Blacklisting always runs through the investigation workflow.
      await decideVendorApproval(
        approver,
        {
          vendorId: created.id,
          decision: "CONDITIONAL",
          reason: "Approved on trial for low-value general supply.",
          entityIds: v.entities.map((e) => entityId[e]),
        },
        prisma,
      );
    }
  }

  log("Vendors", `${VENDORS.length} vendors registered and scored`);
}

async function seedVendorGovernance() {
  const director = users["kamran.rasheed@zameen.com"];
  const auditor = users["faryal.qureshi@zameen.com"];
  const senior = users["asim.javed@zameen.com"];
  const officer = users["hira.aslam@zameen.com"];

  // A completed investigation ending in blacklisting.
  const zenith = vendorId["Zenith Trading Company"];
  await raiseVendorIssue(
    officer,
    {
      vendorId: zenith,
      issueType: "ALTERED_DOCUMENT",
      severity: "CRITICAL",
      title: "Altered sales tax registration certificate submitted with quotation",
      description:
        "The STRN certificate attached to the vendor's quotation showed signs of digital alteration. FBR verification returned a different registration status for the stated NTN.",
    },
    prisma,
  );
  await raiseVendorIssue(
    officer,
    {
      vendorId: zenith,
      issueType: "PRICE_MISMATCH",
      severity: "HIGH",
      title: "Invoice priced above accepted quotation on two consecutive orders",
      description:
        "Invoices were submitted at unit rates 8% and 11% above the quoted and awarded rates, without any approved variation.",
    },
    prisma,
  );

  const kase = await openBlacklistCase(
    director,
    {
      vendorId: zenith,
      reason:
        "Submission of an altered sales tax registration certificate, compounded by repeated invoice price mismatches against awarded rates.",
      reasonCode: "ALTERED_DOCUMENTS",
      evidence:
        "Quotation dated with altered STRN certificate; FBR online verification screenshot; invoices INV-A and INV-B against awarded comparative rates.",
      auditRequired: true,
      suspendImmediately: true,
    },
    prisma,
  );
  await advanceBlacklistCase(senior, kase.id, "EVIDENCE_COLLECTION", {
    notes: "Original certificate obtained from the vendor's file. FBR verification printed and attached. Both invoices pulled with the awarded comparative.",
  }, prisma);
  await advanceBlacklistCase(senior, kase.id, "INVESTIGATION", {
    notes:
      "Document forensics confirm the registration number field was edited. Price variance confirmed at 8.4% and 11.2% against awarded rates on two orders.",
  }, prisma);
  await advanceBlacklistCase(senior, kase.id, "VENDOR_RESPONSE_AWAITED", {
    vendorResponse:
      "Vendor stated the certificate was supplied by a third-party consultant and denied knowledge of the alteration. No explanation offered for the invoice price variances.",
  }, prisma);
  await advanceBlacklistCase(senior, kase.id, "PROCUREMENT_REVIEW", {
    procurementReview:
      "The vendor's response does not address the price variances and does not rebut the document alteration. Procurement recommends blacklisting.",
  }, prisma);
  await advanceBlacklistCase(auditor, kase.id, "AUDIT_REVIEW", {
    auditReview:
      "Audit has independently verified the altered certificate and both invoice variances. Audit concurs with the procurement recommendation. No further orders should be placed.",
  }, prisma);
  await advanceBlacklistCase(director, kase.id, "DECISION_PENDING", {}, prisma);
  await advanceBlacklistCase(director, kase.id, "BLACKLISTED", {
    decisionNotes:
      "Blacklisted with immediate effect. Document forgery is a zero-tolerance violation under procurement policy; the price mismatches independently justify removal.",
  }, prisma);

  // A live investigation still in progress.
  const digital = vendorId["Digital World Computers"];
  await raiseVendorIssue(
    officer,
    {
      vendorId: digital,
      issueType: "LATE_DELIVERY",
      severity: "MEDIUM",
      title: "Repeated late delivery on monitor supply",
      description: "Two consecutive orders delivered 9 and 12 days beyond the promised date without prior notice.",
    },
    prisma,
  );

  const cool = vendorId["Cool Air Engineering"];
  await raiseVendorIssue(
    officer,
    {
      vendorId: cool,
      issueType: "SERVICE_FAILURE",
      severity: "LOW",
      title: "Delayed response on warranty call for 4th floor cassette unit",
      description: "Warranty service call logged and attended after 5 working days against a 48-hour SLA.",
    },
    prisma,
  );

  log("Vendor governance", "1 completed blacklist investigation, 4 vendor issues");
}

/** Historical purchase prices so comparatives have a previous-price baseline. */
async function seedPriceHistory() {
  const history: Array<[string, string, number, number]> = [
    ["IT-LAP-0001", "Techno Solutions", 372000, 240],
    ["IT-LAP-0001", "Digital World Computers", 379000, 400],
    ["IT-LAP-0002", "Techno Solutions", 598000, 300],
    ["IT-PRN-0001", "Techno Solutions", 452000, 260],
    ["IT-MON-0001", "Digital World Computers", 59500, 180],
    ["CST-STL-0001", "Amreli Steels Distributor — Steel Line", 259000, 95],
    ["CST-STL-0001", "Mughal Steel Direct", 262500, 150],
    ["CST-STL-0002", "Amreli Steels Distributor — Steel Line", 256000, 120],
    ["CST-CEM-0001", "Maple Leaf Cement Dealer — Bilal Traders", 1340, 70],
    ["HVA-SPL-0001", "Cool Air Engineering", 192000, 200],
    ["HVA-SPL-0001", "Breeze Cooling Systems", 197500, 260],
    ["FUR-CHR-0001", "Interwood Mobel", 66200, 150],
    ["FUR-DSK-0001", "Interwood Mobel", 79500, 150],
    ["OFF-PAP-0001", "Al-Noor Stationers", 1280, 40],
    ["OFF-PEN-0001", "Al-Noor Stationers", 820, 40],
    ["FIT-TIL-0001", "Bright Build Materials", 372000 / 1000, 90],
    ["MEP-CBL-0001", "Prime Electricals", 1140, 110],
  ];
  for (const [sku, vendor, price, daysAgo] of history) {
    if (!itemId[sku] || !vendorId[vendor]) continue;
    await prisma.priceHistory.create({
      data: {
        itemId: itemId[sku],
        vendorId: vendorId[vendor],
        unitPrice: price,
        source: "PO",
        sourceRef: `HIST-${sku}`,
        recordedAt: D(daysAgo),
      },
    });
  }
  log("Price history", `${history.length} historical purchase prices`);
}

export { prisma, users, entityId, departmentId, projectId, siteId, storeId, locationId, categoryId, itemId, vendorId, sessionFor, D, FUTURE, backdateCase, log };

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function main() {
  process.stdout.write("\nSeeding Heimdall\n\n");
  await reset();
  await seedRbac();
  await seedOrg();
  await seedCatalogue();
  await seedUsers();
  await seedConfig();
  await seedApprovalRules();
  await seedVendors();
  await seedVendorGovernance();
  await seedPriceHistory();

  const { seedFlows } = await import("./seed-flows");
  await seedFlows();

  await recomputeAllVendorPerformance(12, prisma);
  await sweepMissingGrns(prisma);
  log("Rollups", "vendor performance recomputed, missing-GRN sweep run");

  const counts = {
    users: await prisma.user.count(),
    vendors: await prisma.vendor.count(),
    requisitions: await prisma.purchaseRequisition.count(),
    rfqs: await prisma.rfq.count(),
    quotes: await prisma.vendorQuote.count(),
    comparatives: await prisma.comparative.count(),
    cpcCases: await prisma.cpcCase.count(),
    purchaseOrders: await prisma.purchaseOrder.count(),
    gatePasses: await prisma.gatePass.count(),
    deliveries: await prisma.delivery.count(),
    inspections: await prisma.inspection.count(),
    grns: await prisma.grn.count(),
    invoices: await prisma.invoice.count(),
    handoffs: await prisma.paymentHandoff.count(),
    pettyCash: await prisma.pettyCashRequest.count(),
    inventoryLines: await prisma.inventoryItem.count(),
    inventoryTxns: await prisma.inventoryTransaction.count(),
    assets: await prisma.asset.count(),
    disposals: await prisma.disposalCase.count(),
    exceptions: await prisma.exception.count(),
    tasks: await prisma.task.count(),
    auditEvents: await prisma.auditLog.count(),
    savings: await prisma.savingsRecord.count(),
  };

  process.stdout.write("\nSeed complete\n");
  for (const [k, v] of Object.entries(counts)) {
    process.stdout.write(`  ${k.padEnd(18)} ${v}\n`);
  }
  process.stdout.write(`\n  Sign in with any seeded email and the password ${PASSWORD}\n`);
  process.stdout.write("  e.g. kamran.rasheed@zameen.com (Procurement Director)\n\n");
}

main()
  .catch((e) => {
    process.stderr.write(`\nSeed failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
