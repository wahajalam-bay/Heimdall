/**
 * Navigation glyphs.
 *
 * One small stroked icon per navigation entry, drawn on a 24-unit grid so every
 * glyph shares the same optical weight. They carry the collapsed rail, where the
 * label is not on screen, so each one has to be recognisable at 18px.
 */

export type NavIconName =
  | "voucher"
  | "budget"
  | "tax"
  | "variance"
  | "return"
  | "dashboard"
  | "workspace"
  | "alerts"
  | "requisition"
  | "rfq"
  | "quote"
  | "comparative"
  | "order"
  | "cash"
  | "receiving"
  | "gate"
  | "inspection"
  | "grn"
  | "clock"
  | "store"
  | "inventory"
  | "issuance"
  | "transfer"
  | "vendor"
  | "verified"
  | "score"
  | "activity"
  | "issue"
  | "blocked"
  | "committee"
  | "case"
  | "calendar"
  | "decision"
  | "invoice"
  | "payment"
  | "asset"
  | "disposal"
  | "scrap"
  | "chart"
  | "savings"
  | "spend"
  | "audit"
  | "report"
  | "users"
  | "roles"
  | "entities"
  | "departments"
  | "projects"
  | "catalogue"
  | "rules"
  | "policies"
  | "criteria"
  | "documents";

const PATHS: Record<NavIconName, string> = {
  dashboard: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  workspace: "M3 13l3-9h12l3 9v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 13h5l1 2h6l1-2h5",
  alerts: "M6 10a6 6 0 0 1 12 0v4l2 3H4l2-3zM10 19a2 2 0 0 0 4 0",
  requisition: "M6 2h8l4 4v16H6zM14 2v4h4M9 12h6M9 16h4",
  rfq: "M21 3 3 10l7 3 3 7zM10 13l5-5",
  quote: "M5 3h11l3 3v15l-3-2-3 2-3-2-3 2zM8 9h8M8 13h6",
  comparative: "M4 20V9h5v11zM15 20V4h5v16zM4 20h16",
  order: "M6 2h8l4 4v16H6zM14 2v4h4M9 15l2.5 2.5L16 13",
  cash: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 12h3M8 12h.01",
  receiving: "M3 6h11v9H3zM14 9h4l3 3v3h-7zM7.5 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M18 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3",
  gate: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4",
  inspection: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.5 16.5 21 21M8.5 11l2 2 3-3.5",
  grn: "M9 4h6v3H9zM6 5h2v2h8V5h2v16H6zM9 14l2.5 2.5L16 11",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v6l4 2",
  store: "M4 9h16l-1 12H5zM8 9V6a4 4 0 0 1 8 0v3",
  inventory: "M3 8l9-4 9 4v8l-9 4-9-4zM3 8l9 4 9-4M12 12v8",
  issuance: "M4 14v6h16v-6M12 3v10M8 7l4-4 4 4",
  transfer: "M4 8h13l-3-3M20 16H7l3 3",
  vendor: "M3 21V8l6-4 6 4v13M15 21V11h6v10M3 21h18M7 12h2M7 16h2",
  verified: "M12 3l2.2 2 3-.4.6 3 2.2 2-2.2 2-.6 3-3-.4L12 21l-2.2-2-3 .4-.6-3L4 14l2.2-2 .6-3 3 .4zM9.5 12l2 2 3.5-3.5",
  score: "M12 4l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9L9.5 9z",
  activity: "M3 12h4l3 7 4-15 3 8h4",
  issue: "M12 4l9 16H3zM12 10v4M12 17h.01",
  blocked: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM6 6l12 12",
  committee: "M12 3v4M6 11h12l-3 4H9zM4 21h16M9 15v6M15 15v6M8 7h8",
  case: "M3 6h6l2 3h10v11H3zM3 12h20",
  calendar: "M4 6h16v15H4zM4 11h16M8 3v4M16 3v4",
  decision: "M4 4h16v16H4zM8 12l3 3 5-6",
  invoice: "M6 2h12v20l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  payment: "M3 10l9-6 9 6M5 10v9h14v-9M9 19v-5h6v5",
  voucher: "M5 3h14v18l-3-2-2 2-2-2-2 2-3-2zM8 8h8M8 12h8M8 16h4",
  budget: "M4 20V9M10 20V4M16 20v-7M22 20H2M13 8l4-3 3 2",
  tax: "M5 3h14v18H5zM9 8h6M9 12h6M9 16h3",
  variance: "M4 18l6-8 4 4 6-9M4 21h17M14 5h6v6",
  return: "M9 5L4 10l5 5M4 10h11a5 5 0 0 1 0 10h-6",
  asset: "M3 5h18v11H3zM9 20h6M12 16v4M7 9h5",
  disposal: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6",
  scrap: "M20 12a8 8 0 1 0-3 6.2M20 6v5h-5M12 8v5l3 2",
  chart: "M4 20V10M10 20V4M16 20v-7M4 20h16",
  savings: "M3 8l6 6 4-4 8 8M13 20h8v-8",
  spend: "M3 17l6-6 4 4 8-8M14 7h7v7",
  audit: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5L16 10",
  report: "M12 3v12M8 11l4 4 4-4M4 21h16",
  users: "M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 8.5a3 3 0 1 0 0-6M16.5 14c3 0 5.5 2.5 5.5 5.5",
  roles: "M13 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0zM13 12H3M6 12v3M9.5 12v2",
  entities: "M4 21V5l8-3 8 3v16M9 9h2M13 9h2M9 13h2M13 13h2M10 21v-4h4v4",
  departments: "M10 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4zM12 7v4M5 17v-2h14v2M12 11v4",
  projects: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14",
  catalogue: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  rules: "M6 6v12M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8v2a4 4 0 0 1-4 4H6",
  policies: "M4 7h9M17 7h3M4 12h4M12 12h8M4 17h12M18 17h2M15 7a2 2 0 1 0-4 0 2 2 0 0 0 4 0zM12 12a2 2 0 1 0-4 0 2 2 0 0 0 4 0z",
  criteria: "M4 7l2 2 3.5-3.5M4 15l2 2 3.5-3.5M13 8h7M13 16h7",
  documents: "M8 3h6l4 4v12H8zM14 3v4h4M5 8v13h9",
};

export function NavIcon({
  name,
  className,
  style,
}: {
  name: NavIconName;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      style={style}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
