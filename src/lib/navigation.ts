import { PERMISSIONS as P } from "./permissions";
import type { NavIconName } from "@/components/shell/NavIcon";

export type NavItem = {
  label: string;
  href: string;
  /** Glyph shown beside the label, and on its own in the collapsed rail. */
  icon: NavIconName;
  /** Any one of these permissions grants visibility. */
  perms?: string[];
  /** Badge key resolved server-side against live counts. */
  badge?:
    | "myTasks"
    | "alerts"
    | "cpcPending"
    | "openPo"
    | "invoiceMismatch"
    | "exceptions"
    | "inspections"
    | "grnPending"
    | "requirementsPending"
    | "srPending"
    | "vouchersPending"
    | "variancesOpen"
    | "returnsOpen";
  exact?: boolean;
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    label: "Home",
    items: [
      { label: "Executive Dashboard", href: "/", icon: "dashboard", exact: true },
      { label: "My Workspace", href: "/workspace", icon: "workspace", badge: "myTasks" },
      { label: "Alerts", href: "/alerts", icon: "alerts", badge: "alerts" },
    ],
  },
  {
    label: "Demand",
    items: [
      {
        label: "Requirements",
        href: "/requirements",
        icon: "requisition",
        perms: [P.REQUIREMENT_VIEW, P.REQUIREMENT_VIEW_ALL],
        badge: "requirementsPending",
      },
      {
        label: "Store Requisitions",
        href: "/issuance",
        icon: "issuance",
        perms: [P.SR_VIEW, P.STORE_ISSUE, P.INVENTORY_VIEW],
        badge: "srPending",
      },
    ],
  },
  {
    label: "Procurement",
    items: [
      { label: "Purchase Requisitions", href: "/pr", icon: "requisition", perms: [P.PR_VIEW, P.PR_VIEW_ALL] },
      { label: "RFQs", href: "/rfq", icon: "rfq", perms: [P.RFQ_VIEW] },
      { label: "Quotations", href: "/quotes", icon: "quote", perms: [P.QUOTE_VIEW] },
      { label: "Comparatives", href: "/comparatives", icon: "comparative", perms: [P.COMPARATIVE_VIEW] },
      { label: "Purchase Orders", href: "/po", icon: "order", perms: [P.PO_VIEW] },
      { label: "Petty Cash", href: "/petty-cash", icon: "cash", perms: [P.PETTY_CASH_VIEW] },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Receiving", href: "/receiving", icon: "receiving", perms: [P.RECEIVING_VIEW, P.RECEIVE_GOODS] },
      { label: "Gate Passes", href: "/gate-passes", icon: "gate", perms: [P.GATE_PASS_VIEW] },
      { label: "Inspections", href: "/inspections", icon: "inspection", perms: [P.INSPECTION_VIEW], badge: "inspections" },
      { label: "GRNs", href: "/grn", icon: "grn", perms: [P.GRN_VIEW] },
      {
        label: "Variances",
        href: "/receiving/variances",
        icon: "variance",
        perms: [P.VARIANCE_VIEW],
        badge: "variancesOpen",
      },
      {
        label: "Vendor Returns",
        href: "/receiving/returns",
        icon: "return",
        perms: [P.RETURN_VIEW],
        badge: "returnsOpen",
      },
      { label: "Open POs", href: "/open-pos", icon: "clock", perms: [P.PO_VIEW], badge: "openPo" },
      { label: "Stores", href: "/stores", icon: "store", perms: [P.INVENTORY_VIEW] },
      { label: "Inventory", href: "/inventory", icon: "inventory", perms: [P.INVENTORY_VIEW] },
      { label: "Transfers", href: "/transfers", icon: "transfer", perms: [P.INVENTORY_VIEW, P.STORE_TRANSFER] },
    ],
  },
  {
    label: "Vendors",
    items: [
      { label: "Vendor Directory", href: "/vendors", icon: "vendor", perms: [P.VENDOR_VIEW] },
      { label: "Pre-Qualification", href: "/vendors/prequalification", icon: "verified", perms: [P.VENDOR_VIEW] },
      { label: "Evaluations", href: "/vendors/evaluations", icon: "score", perms: [P.VENDOR_VIEW] },
      { label: "Performance", href: "/vendors/performance", icon: "activity", perms: [P.VENDOR_VIEW] },
      { label: "Issues", href: "/vendors/issues", icon: "issue", perms: [P.VENDOR_VIEW] },
      { label: "Blacklist", href: "/vendors/blacklist", icon: "blocked", perms: [P.VENDOR_VIEW] },
    ],
  },
  {
    label: "CPC",
    items: [
      { label: "CPC Dashboard", href: "/cpc", icon: "committee", perms: [P.CPC_VIEW], exact: true },
      { label: "Cases", href: "/cpc/cases", icon: "case", perms: [P.CPC_VIEW], badge: "cpcPending" },
      { label: "Meetings", href: "/cpc/meetings", icon: "calendar", perms: [P.CPC_VIEW] },
      { label: "Decisions", href: "/cpc/decisions", icon: "decision", perms: [P.CPC_VIEW] },
    ],
  },
  {
    label: "Finance",
    items: [
      { label: "Invoice Verification", href: "/invoices", icon: "invoice", perms: [P.INVOICE_VIEW], badge: "invoiceMismatch" },
      {
        label: "Payment Vouchers",
        href: "/finance/vouchers",
        icon: "voucher",
        perms: [P.VOUCHER_VIEW],
        badge: "vouchersPending",
      },
      { label: "Payment Handoff", href: "/finance/handoffs", icon: "payment", perms: [P.INVOICE_VIEW, P.FINANCE_ACK] },
      { label: "Pending Payments", href: "/finance/pending", icon: "clock", perms: [P.INVOICE_VIEW] },
      { label: "Budgets", href: "/finance/budgets", icon: "budget", perms: [P.BUDGET_VIEW] },
      { label: "Tax Rates", href: "/finance/taxes", icon: "tax", perms: [P.TAX_VIEW] },
    ],
  },
  {
    label: "Assets",
    items: [
      { label: "Asset Register", href: "/assets", icon: "asset", perms: [P.ASSET_VIEW] },
      { label: "Disposal", href: "/disposal", icon: "disposal", perms: [P.DISPOSAL_VIEW] },
      { label: "Scrap", href: "/disposal/scrap", icon: "scrap", perms: [P.DISPOSAL_VIEW] },
    ],
  },
  {
    label: "Analytics",
    items: [
      { label: "Procurement Analytics", href: "/analytics", icon: "chart", perms: [P.ANALYTICS_VIEW], exact: true },
      { label: "Savings", href: "/analytics/savings", icon: "savings", perms: [P.ANALYTICS_VIEW] },
      { label: "Spend", href: "/analytics/spend", icon: "spend", perms: [P.ANALYTICS_VIEW] },
      { label: "Vendor Analytics", href: "/analytics/vendors", icon: "vendor", perms: [P.ANALYTICS_VIEW] },
      { label: "Performance", href: "/analytics/performance", icon: "activity", perms: [P.ANALYTICS_VIEW] },
      { label: "Bottlenecks", href: "/analytics/bottlenecks", icon: "clock", perms: [P.ANALYTICS_VIEW] },
      { label: "Exceptions", href: "/analytics/exceptions", icon: "issue", perms: [P.EXCEPTION_VIEW], badge: "exceptions" },
      { label: "Audit Trail", href: "/analytics/audit", icon: "audit", perms: [P.AUDIT_VIEW] },
      { label: "Reports", href: "/analytics/reports", icon: "report", perms: [P.EXPORT_DATA] },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "Users", href: "/admin/users", icon: "users", perms: [P.USER_MANAGE] },
      { label: "Roles & Permissions", href: "/admin/roles", icon: "roles", perms: [P.ROLE_MANAGE] },
      { label: "Organogram", href: "/admin/organogram", icon: "users", perms: [P.USER_MANAGE, P.MASTER_VIEW] },
      { label: "Entities", href: "/admin/entities", icon: "entities", perms: [P.MASTER_DATA_MANAGE] },
      { label: "Departments", href: "/admin/departments", icon: "departments", perms: [P.MASTER_DATA_MANAGE] },
      { label: "Projects & Sites", href: "/admin/projects", icon: "projects", perms: [P.MASTER_DATA_MANAGE] },
      { label: "Stores & Locations", href: "/admin/stores", icon: "store", perms: [P.MASTER_DATA_MANAGE] },
      { label: "Categories & Items", href: "/admin/catalogue", icon: "catalogue", perms: [P.MASTER_DATA_MANAGE] },
      { label: "Approval Rules", href: "/admin/approval-rules", icon: "rules", perms: [P.APPROVAL_RULE_MANAGE] },
      { label: "Policies & Thresholds", href: "/admin/policies", icon: "policies", perms: [P.CONFIG_MANAGE] },
      { label: "Policy decisions", href: "/admin/policy-conflicts", icon: "policies", perms: [P.CONFIG_MANAGE] },
      { label: "Evaluation Criteria", href: "/admin/evaluation-criteria", icon: "criteria", perms: [P.CONFIG_MANAGE] },
      { label: "Document Types", href: "/admin/document-types", icon: "documents", perms: [P.CONFIG_MANAGE] },
      { label: "Email Delivery", href: "/admin/email", icon: "rfq", perms: [P.CONFIG_MANAGE] },
    ],
  },
];

export function visibleNav(permissions: string[]): NavGroup[] {
  const has = (perms?: string[]) => !perms || perms.some((p) => permissions.includes(p));
  return NAV.map((g) => ({ label: g.label, items: g.items.filter((i) => has(i.perms)) })).filter(
    (g) => g.items.length > 0,
  );
}
