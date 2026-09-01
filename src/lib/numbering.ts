import { prisma, type DbClient } from "./db";

/**
 * Gap-free document numbering.
 *
 * Counters live in `number_sequences` and are bumped with an atomic increment so
 * concurrent callers never collide, per prefix + year.
 */

export const SEQ = {
  REQUIREMENT: "REQ",
  PR: "PR",
  MD: "MD",
  RFQ: "RFQ",
  QUOTE: "QT",
  COMPARATIVE: "CMP",
  NEGOTIATION_MINUTE: "NGM",
  PO: "PO",
  WORK_ORDER: "WO",
  CONTRACT: "CTR",
  GATE_PASS: "GP",
  SERVICE_ACCEPTANCE: "SAC",
  DELIVERY: "DLV",
  INSPECTION: "INSP",
  GRN: "GRN",
  INVOICE: "INV",
  HANDOFF: "PAY",
  PETTY_CASH: "PC",
  VOUCHER: "PCV",
  PAYMENT_VOUCHER: "PV",
  VARIANCE: "VAR",
  REJECTION: "REJ",
  VENDOR_RETURN: "RTN",
  CPC_CASE: "CPC",
  CPC_MEETING: "CPCM",
  VENDOR: "V",
  VENDOR_EVAL: "VEV",
  VENDOR_ISSUE: "VIS",
  BLACKLIST: "VBL",
  EXCEPTION: "EXC",
  INV_TXN: "ITX",
  STOCK_COUNT: "STC",
  EMPLOYEE_RETURN: "ERN",
  LOSS_REPORT: "LOS",
  ISSUE: "SIS",
  TRANSFER: "STR",
  ASSET: "AST",
  DISPOSAL: "DSP",
} as const;

export type SeqKey = (typeof SEQ)[keyof typeof SEQ];

/**
 * Produces e.g. `PR-2026-00124`.
 * Serial gate passes use `serialFor` for the additional unique serial.
 */
export async function nextNumber(prefix: string, db: DbClient = prisma, when = new Date()): Promise<string> {
  const year = when.getFullYear();
  const key = `${prefix}-${year}`;

  // Upsert-then-increment keeps the operation atomic at the SQL level.
  await db.numberSequence.upsert({
    where: { key },
    create: { key, prefix, year, counter: 0 },
    update: {},
  });
  const row = await db.numberSequence.update({
    where: { key },
    data: { counter: { increment: 1 } },
  });
  return `${prefix}-${year}-${String(row.counter).padStart(row.padding, "0")}`;
}

/** Gate-pass style serial: monotonic within the year, no prefix. */
export async function nextSerial(prefix: string, db: DbClient = prisma, when = new Date()): Promise<string> {
  const year = when.getFullYear();
  const key = `${prefix}SER-${year}`;
  await db.numberSequence.upsert({
    where: { key },
    create: { key, prefix: `${prefix}SER`, year, counter: 100000, padding: 6 },
    update: {},
  });
  const row = await db.numberSequence.update({ where: { key }, data: { counter: { increment: 1 } } });
  return `${year}${String(row.counter).slice(-6)}`;
}

/** PRs of type MATERIAL_DEMAND get an MD- number so site teams recognise them. */
export function prefixForProcurementType(procurementType: string) {
  return procurementType === "MATERIAL_DEMAND" ? SEQ.MD : SEQ.PR;
}
