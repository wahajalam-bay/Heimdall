import { PERMISSIONS as P } from "./permissions";

/**
 * Catalogue of exportable reports. Kept separate from the export route so pages
 * can list what is available without importing the route module; the route is
 * the single place that actually builds and permission-checks each report.
 */
export type ReportDef = {
  key: string;
  label: string;
  description: string;
  perms: string[];
  group: "Spend and savings" | "Operations" | "Governance" | "Stock and assets";
  supportsDateRange: boolean;
};

export const REPORT_CATALOGUE: ReportDef[] = [
  {
    key: "spend",
    label: "Spend by category",
    description: "Purchase order value grouped by item category, with share of total.",
    perms: [P.ANALYTICS_VIEW],
    group: "Spend and savings",
    supportsDateRange: true,
  },
  {
    key: "spend-vendor",
    label: "Spend by vendor",
    description: "Value and share by vendor — the concentration view finance asks for.",
    perms: [P.ANALYTICS_VIEW],
    group: "Spend and savings",
    supportsDateRange: true,
  },
  {
    key: "savings",
    label: "Savings register",
    description: "Every recorded saving with its baseline, negotiated price and basis.",
    perms: [P.ANALYTICS_VIEW],
    group: "Spend and savings",
    supportsDateRange: true,
  },
  {
    key: "pr",
    label: "Purchase requisitions",
    description: "All requisitions with status, value, department and requester.",
    perms: [P.PR_VIEW],
    group: "Operations",
    supportsDateRange: true,
  },
  {
    key: "po",
    label: "Purchase orders",
    description: "Orders with ordered, accepted and invoiced quantities against each.",
    perms: [P.PO_VIEW],
    group: "Operations",
    supportsDateRange: true,
  },
  {
    key: "grn",
    label: "Goods receipts",
    description: "Receipts with received, accepted and rejected quantities and value.",
    perms: [P.GRN_VIEW],
    group: "Operations",
    supportsDateRange: true,
  },
  {
    key: "invoices",
    label: "Invoices and match status",
    description: "Invoices with three-way match outcome, mismatched lines and payment state.",
    perms: [P.INVOICE_VIEW],
    group: "Operations",
    supportsDateRange: true,
  },
  {
    key: "petty-cash",
    label: "Petty cash",
    description: "Cash purchases with quote counts and outstanding store entries.",
    perms: [P.PETTY_CASH_VIEW],
    group: "Operations",
    supportsDateRange: true,
  },
  {
    key: "vendors",
    label: "Vendor analytics",
    description: "Qualification, performance, concentration and issue counts per vendor.",
    perms: [P.VENDOR_VIEW],
    group: "Governance",
    supportsDateRange: false,
  },
  {
    key: "exceptions",
    label: "Exceptions",
    description: "Control breaches with severity, blocking status and resolution.",
    perms: [P.EXCEPTION_VIEW],
    group: "Governance",
    supportsDateRange: true,
  },
  {
    key: "bottlenecks",
    label: "Bottlenecks",
    description: "Every place work is sitting, with owner, age, SLA and next action.",
    perms: [P.ANALYTICS_VIEW],
    group: "Governance",
    supportsDateRange: false,
  },
  {
    key: "audit",
    label: "Audit trail",
    description: "Actions, actors, reasons and field-level changes.",
    perms: [P.AUDIT_VIEW],
    group: "Governance",
    supportsDateRange: true,
  },
  {
    key: "inventory",
    label: "Inventory valuation",
    description: "Stock by store and batch with quantity, unit cost and value.",
    perms: [P.INVENTORY_VIEW],
    group: "Stock and assets",
    supportsDateRange: false,
  },
  {
    key: "assets",
    label: "Asset register",
    description: "Assets with custodian, location, cost, current value and warranty.",
    perms: [P.ASSET_VIEW],
    group: "Stock and assets",
    supportsDateRange: false,
  },
  {
    key: "disposal",
    label: "Disposal cases",
    description: "Disposal cases with book value, bids and value actually realised.",
    perms: [P.DISPOSAL_VIEW],
    group: "Stock and assets",
    supportsDateRange: true,
  },
];

export const REPORT_GROUPS = ["Spend and savings", "Operations", "Governance", "Stock and assets"] as const;
