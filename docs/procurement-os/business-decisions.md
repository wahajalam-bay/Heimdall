# Business Decision Register — Zameen Media

Where **ZAM/PUR/SOP-01**, the **approved meeting requirements** and the **current
system** disagree, nothing is silently reconciled. Each disagreement is recorded
here with what each source says, what the system does today, what changes
depending on the answer, and one precise decision.

Until a decision is made, the architecture is configurable and the shipped
reading is stated. A configurable default is not a decision — the register
reports these as open.

**Scope note.** `ZD/PRO/SOP-01` is reference material. It appears below only
where a meeting requirement points at something that is *described* solely in the
ZD document — which is a real problem, not a scope violation, and BD-003 is
exactly that case.

| ID | Subject | Blocks | Status |
|---|---|---|---|
| BD-001 | Which Roles & Responsibilities are Zameen Media's | 34 matrix rows | **CLOSED** — answered from the document |
| BD-002 | Asset vs consumable below PKR 15,000 | Treatment engine, Expense Book | **OPEN — sources contradict** |
| BD-003 | What JEFFI is | Payment workflow | **OPEN — no definition in any ZAM source** |
| BD-004 | Sage integration direction | Item/Vendor master ownership | **OPEN — no implementation to infer from** |
| BD-005 | Applicable tax rates | Tax Master, Cost Analysis, Invoice | **OPEN — no rate in any source** |
| BD-006 | Vendor performance qualifying score and instrument | Performance rebuild | **OPEN** |
| BD-007 | Does the committee threshold cover services | CPC routing | **OPEN** |
| BD-008 | FIFO costing alongside FEFO picking | Inventory valuation | **OPEN — confirm, likely both** |
| BD-009 | Definition of an Exceptional Purchase | CEO routing | **OPEN** |
| BD-010 | Prohibited role combinations | Segregation of duties | **OPEN — no combination stated** |

---

## BD-001 · Which Roles & Responsibilities belong to Zameen Media — **CLOSED**

Answered by reading ZAM/PUR/SOP-01 rather than by asking. Zameen Media states its
responsibilities in three places, and **none of them corresponds to the 34-row
`R-###` series that came from the ZD SOP.**

| Location | What it contains |
|---|---|
| **§3 Responsibilities** | **Four clauses.** 3.1 Director/Sr Manager Procurement — resources, selection, pre-qualification, registration, monitoring performance of approved suppliers, and ensuring procurement follows the stipulated process. 3.2 Requesting departmental POCs — define specifications, quality, brand, frequency; **after delivery the concerned department head verifies specifications and signs the Material Inspection form**. 3.3 Manager Logistics — maintain the stock list and **minimum stock level derived from consumption history or POC advice**, keep receipt and issuance records, present them on demand. 3.4 Procurement team — process all invoices and ensure supporting documents **as per Annexure A** |
| **ROLES & RESPONSIBILITIES** (p. 33) | Ten departments in prose — Sales, Administration, Architect, Procurement, IT, Legal, Finance, HR Operations, Marketing, Internal Audit. **Build-out scoped** |
| **Checklist of Roles & Responsibilities** | The document's final heading, with its content entirely in two images (`image23.PNG`, `image24.PNG`): ten departments, **33 named responsibilities**, build-out scoped |

**Outcome.** Zameen Media has **4 procurement responsibilities, not 34.** The ZD
series stays `FUTURE / ZD ONLY` and the in-scope count is unchanged at 147 plus a
new `R-ZAM` series of 37 rows — 4 clauses and 33 checklist duties.

**And the four clauses are not decoration.** Three of them name controls the
system does not evidence:

- **§3.2** requires the *concerned department* to verify specifications and sign
  the inspection form. Inspection today records the inspector, not the requesting
  department's verification. Annexure 4 has a second signature block for exactly
  this, and it is missing.
- **§3.3** requires the minimum stock level to be **derived from consumption
  history or POC advice**. It is currently a manual number with no derivation and
  no named owner.
- **§3.4** requires the Annexure A document set before an invoice goes to
  finance. All 30 document types are still `optional`.

**§3.1** is the softest: the roles and permissions exist, but "monitor
performance and evaluation of existing approved suppliers" leaves no evidence
that monitoring happened. It becomes a dated control on the Control Calendar
rather than an implication of holding a permission.

The 33 checklist duties land with the build-out module, where they become the
departmental task matrix the brief asks for — built from the document instead of
invented.

## BD-002 · Asset vs consumable below PKR 15,000

**Meeting requirement A.** No asset treatment should occur below PKR 15,000.

**Meeting requirement B.** A coffee table below PKR 15,000 may still represent a
fixed asset.

These two cannot both hold as written. The brief itself flags the contradiction.

**ZAM/PUR/SOP-01.** States no capitalisation threshold.

**Current system.** `Category.assetTagRequired` plus a per-line `disposition` of
`ASSET`. Treatment is effectively a property of the item's category, so the same
item cannot be an asset in an office and a consumable on a project — which is the
distinction the meeting notes ask for.

**Impact.** Determines whether the threshold is a hard bar, a default with an
approved exception, or a prompt. It also determines what the Expense Book counts.

**Recommendation.** Configurable capitalisation policy with three parts: a
threshold, a mode (`HARD_BAR` / `DEFAULT_WITH_EXCEPTION` / `ADVISORY`), and a
category allow-list that can capitalise below the threshold. Ship
`DEFAULT_WITH_EXCEPTION` at PKR 15,000, which satisfies both statements: below it
the default is consumable, and an approved, reasoned override can still
capitalise a coffee table. Every override records who requested it, who approved
it, and why.

**Question.** Confirm the mode, and who may approve a below-threshold
capitalisation.

---

## BD-003 · What JEFFI is

**Meeting requirement.** "JEFFI workflow will be in this."

**Searched, with results.** `JEFFI` appears **nowhere** in ZAM/PUR/SOP-01,
nowhere in the codebase, and nowhere in the database schema. Its only
documentary appearance is in `ZD/PRO/SOP-01`'s payment flow image
(`image14.png`), three times: *"Procurement compile set of documents for payment,
make PV, enter JEFFI & keep scan record"*, *"Transfer JEFFI & original set of
documents to the Finance"*, *"Finance transfer JEFFI to KPMG for tax working"*.

**What that tells us.** JEFFI is produced by Procurement alongside the payment
voucher, is transferable, is scanned, and travels to an external tax adviser. It
is therefore a document or a system record, not a process stage. Beyond that the
evidence does not reach.

**The problem, precisely.** A meeting requirement puts JEFFI in Zameen Media
scope, while the only description of it sits in the document that is explicitly
*not* a Zameen Media source. I cannot implement it from the ZD flow without
importing a ZD control into ZAM, which the scope forbids.

**Impact.** JEFFI sits between voucher creation and the tax step. Guessing wrong
means either a mandatory artefact nobody produces, or a payment chain missing a
required record.

**Recommendation.** Nothing is built until it is defined. If the answer is "a
document", it becomes a required document type in the Payment Pack with the
normal versioning and attestation — a day's work. If it is an external system, it
follows the same adapter, outbox and reconciliation pattern as Sage, and is
marked blocked until its interface is specified.

**Question.** Is JEFFI a form, a register, an internal workflow, or an external
system — and does Zameen Media use it at all, or was it named from the ZD process?

---

## BD-004 · Sage integration direction

**Meeting requirement.** Item Master and Vendor Master exist in Sage. Integration
is also required around PR, PO, GRN, Vendor Master and Inventory.

**Searched, with results.** There is **no Sage integration.** The only trace in
the entire codebase is `Asset.sageCode String?` (`prisma/schema.prisma:2254`) —
a nullable text field on the asset register with no writer, no reader and no sync
logic. None of `externalId`, `sourceSystem`, `syncStatus`, `lastSyncedAt` exists
on any model. `ZAM/PUR/SOP-01` names "Sage 300" once, in the item-groups image.

**Impact.** This is an architecture decision, not a feature. If Sage owns Item
and Vendor master, this system must stop treating them as locally authored and
become a consumer with local procurement-only attributes — which changes the
Vendor and Item screens, the master-data workflows, and who may edit what. If
this system is the book of record and feeds Sage, the flow is outbound and local
editing stays.

**Recommendation.** Build the boundary without guessing the direction: external
id and sync-metadata columns, an outbox, an adapter interface, a reconciliation
screen and a test stub. Mark the live mapping **BLOCKED BY SAGE API
SPEC/CREDENTIALS**. No fake success. Direction becomes configuration per master.

**Question.** For each of Item Master and Vendor Master: is Sage the owner, is
this system the owner, or is it bidirectional — and do Sage API credentials and
specification exist?

---

## BD-005 · Applicable tax rates

**ZAM/PUR/SOP-01 §4.8.** "In accordance with the requirements of the Income Tax
Ordinance currently applicable in Pakistan." **No percentage is stated.**

**ZAM payment flow (`image14.PNG`).** Tax computation is routed to **KPMG**, an
external adviser — so the SOP deliberately does not fix a rate.

**Meeting requirement.** "Applicable taxes as per Government of Pakistan —
provide dropdown."

**Current system.** Fixed in this release: `policy.tax_rates` is effective-dated
per entity and **empty**, so a form prints tax as unset and says why. The invented
18% global default is now 0 and documented as a data-entry pre-fill. The Cost
Analysis Form's 16% is gone.

**Impact.** The dropdown the meeting requires has nothing to populate it until
rates are entered. Cost Analysis, PR/PO lines, Invoice and Payment all read the
same engine, so one set of entries serves all four.

**Recommendation.** Tax Master as briefed — name, code, goods/services/both,
percentage or method, withholding flag, registered/non-registered applicability,
entity, effective from/to, active, source reference, created/approved by. Applied
rules are snapshotted onto each transaction so a later change never alters
history.

**Question.** The initial rate set: which taxes, at what percentages, applying to
goods, services or both, effective from when.

---

## BD-006 · Vendor performance qualifying score and instrument

**Source A — narrative table.** Six criteria: Quality 40 · Delivery Lead Time 20
· Price Competitiveness 20 · Order Fulfilment 10 · After Sales Service 5 · Credit
Offered 5. Weighted total 100.

**Source B — `image11.png`.** Five criteria: Quality 40 · Delivery Lead Time 20 ·
Competitiveness of Price **30** · Technical Support Staff's Expertise **5** ·
After Sale Services 5.

**Matrix row V-028** records a qualifying score of **50/100** for performance,
which is a different instrument from pre-qualification's **30/60**.

**Meeting requirement.** Weighted total = 100, with the six dimensions of
Source A named explicitly.

**Current system.** Neither. Twenty unweighted pre-qualification criteria are
being used as the performance sheet — the brief calls this out and it is correct.

**Impact.** Which vendors pass, and therefore which vendors may be sourced from
once the performance gate is enforced.

**Recommendation.** The meeting requirement names the six dimensions and the
total of 100, and it outranks the annexure image as Source 2. So the six-criterion
instrument is the one to build, versioned, with the image variant retained as an
alternate version rather than discarded. Pre-qualification scoring stays entirely
separate.

**Question.** Confirm six criteria at 40/20/20/10/5/5 with a qualifying score of
50/100 — and confirm 50 rather than the 30 that pre-qualification uses.

---

## BD-007 · Does the committee threshold cover services

**Source A — engagement limit.** "Procurement of **Goods** — Greater than or
Equal to PKR 500,000."

**Source B — mandate.** "**Any transaction** including but not limited to: SLA ·
Service Contracts · AMC · Buildouts · Onetime Purchases · Exceptional Purchases."

**Current system.** `cpcRequirement` now reads a threshold per transaction type
and ships the wider mandate reading, so a service contract is referred rather
than routed around a committee whose own mandate names it.

**Impact.** Whether service contracts, AMCs and build-outs reach the committee at
PKR 500,000, at another figure, or always.

**Recommendation.** Keep the per-type thresholds. Confirm the figure for services
rather than assuming it matches goods.

**Question.** The committee threshold for each of services, SLA, AMC, build-out
and one-time purchase.

---

## BD-008 · FIFO costing alongside FEFO picking

**Meeting requirement.** FIFO cost layers, with the worked example: 10 @ 100 then
10 @ 120, an issue of 12 consuming 10 @ 100 and 2 @ 120.

**Current system.** FEFO — earliest expiry first — for physical picking, which is
correct for expiry-sensitive stock and is *not* a costing method. There are no
cost layers.

**Impact.** Inventory valuation, issue cost, and the Expense Book's asset and
consumable values.

**Recommendation.** Implement FIFO cost layers as a separate concern from picking
order, so physical selection stays FEFO where expiry matters while cost
consumption follows receipt order. Record which layer each issue consumed. The
existing ledger is not rewritten; layers start from a stated date.

**Question.** Confirm both are wanted — FEFO for physical picking, FIFO for cost
— and the date from which cost layers begin.

---

## BD-009 · Definition of an Exceptional Purchase

**Source A — committee mandate.** "Exceptional Purchases (Must be approved by
CEO)." No value, no definition.

**Source B — committee terms of reference.** "All purchases above PKR 1,500,000
are to be approved by Office of CEO."

**Current system.** The value tier is implemented — `cpcRequirement` returns
`ceoRequired` above PKR 1,500,000, and the threshold is configuration. The
classification trigger is gated behind
`policy.exceptional_purchase_definition_confirmed`, false until defined.

**Impact.** Whether a purchase below PKR 1,500,000 can still require CEO approval
by virtue of being exceptional.

**Question.** What makes a purchase exceptional, independent of its value.

---

## BD-010 · Prohibited role combinations

**ZAM/PUR/SOP-01.** States no prohibited combination.

**Meeting requirement.** Segregation of duties, with examples that are all
**per-transaction** — a preparer not verifying their own cost analysis, a
requester not self-approving.

**Current system.** The three per-transaction separations are enforced and
audited. Role-assignment conflict checking runs on every grant but its list is
**empty by default**, because 22 roles produce 231 possible pairs and several
that look conflicting are how the organisation works today — a head of department
legitimately raises requisitions for their own team and legitimately approves
that team's requisitions.

**Impact.** Populating the list wrongly locks people out of work they do now.

**Question.** Are there role pairs nobody may hold at once — and if so, which,
and why.
