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
| BD-008 | FIFO costing alongside FEFO picking | Inventory valuation | **CLOSED — both, side by side** |
| BD-009 | Definition of an Exceptional Purchase | CEO routing | **OPEN** |
| BD-010 | Prohibited role combinations | Segregation of duties | **OPEN — no combination stated** |
| BD-011 | Payment pack for a service invoice | Service payments | **OPEN — Annexure A assumes a GRN** |
| BD-012 | Undertaking and GD document types | Payment pack accuracy | **OPEN — no exact type exists** |
| BD-013 | Who inspects construction, MEP, machinery and vehicles | Inspection routing | **OPEN — the chart covers 6 of 17 categories** |

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

## BD-008 · FIFO costing alongside FEFO picking — **CLOSED**

The meeting brief §11 states the requirement and its own worked example:

> Receipt 1: 10 units @ 100, Receipt 2: 10 units @ 120, Issue 12: 10 @ 100, 2 @ 120.
> Store the cost-layer consumption. Expiry-sensitive physical picking may continue
> using FEFO where required. Do not corrupt existing inventory ledger history.

**Answered: both, and they are deliberately different answers to different
questions.**

| | FEFO | FIFO |
|---|---|---|
| Asks | which physical carton leaves the shelf | what that carton is carried at |
| Orders by | earliest expiry | earliest receipt |
| Lives in | `allocateOutbound` — unchanged | `server/costing.ts` — new |

They can legitimately disagree, and the system does not hide it. A carton picked
for its expiry date may be valued against an older, cheaper layer; the
consumption rows record exactly which layer each unit was drawn from, so the
disagreement is inspectable rather than averaged away.

**What was built.** `CostLayer` (one receipt at the price that receipt was bought
at) and `CostLayerConsumption` (what one issue took from which layer). Every
inbound movement opens a layer; every outbound movement draws the oldest first.
The system's worked example reproduces the brief's exactly: FIFO 1,240 where the
weighted average says 1,320.

**Three things it deliberately does not do.**

1. **It does not restate history.** Layers begin on a date the business sets
   (`inventory.cost_layers_from`, blank by default). Every movement posted before
   it keeps the weighted-average figure it was posted with, and its `fifoValue`
   stays *null* — which reads as "not computed", a different claim from zero.
2. **It does not invent an opening layer.** Stock received before the cutover has
   no layer and never will. The first issues after the cutover therefore report
   part of their quantity as **uncovered**, and no FIFO figure is claimed for
   them. Manufacturing an opening layer at a price nobody paid would make the
   report look complete while being wrong.
3. **It does not switch the method on its own.** `inventory.costing_method` ships
   `WEIGHTED_AVERAGE`, which is what every movement in the ledger was posted
   under. Layers are maintained either way, so the business can see the FIFO
   figure beside the average for as long as it likes before switching — and
   switching changes what *future* issues cost, not what past ones did. Each
   ledger row records which method its `value` came from, so no reader has to
   guess.

**A return goes back on the layer it left.** `postMovement` accepts
`reversalOfTransactionId`; a positive movement that names its original issue
restores those layers instead of opening a new one at today's price. Without it,
handing back stock that cost 100 would quietly revalue it at the last receipt's
price — a return would become a profit or a loss.


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

---

## BD-011 · What a service invoice needs in place of a GRN

**ZAM/PUR/SOP-01 Annexure A.** Lists seven documents, of which the **GRN** is one
of the four unconditional ones. The chain is written around goods arriving.

**The problem.** A service has no goods receipt. Requiring one on a service
invoice makes every service payment impossible; dropping it silently makes a
service payment answer to four documents where a goods payment answers to five.

**Current system.** The Annexure A pack is seeded for `transactionType = GOODS`
only. A service invoice therefore has **no pack requirements at all**, which is
honest — nothing has been invented — but it means services currently carry no
document control.

**Impact.** Every service payment, and every work order and contract payment once
those exist.

**Recommendation.** Seed a services pack that mirrors Annexure A with the service
acceptance record standing where the GRN stands: requisition, order, **confirmed
service acceptance**, invoice, plus the same three conditionals. That is a
substitution of like for like — the acceptance is the services evidence that the
work happened, exactly as the receipt is for goods — but it is a substitution the
SOP does not make, so it needs saying rather than assuming.

**Question.** Confirm the services pack is requisition, order, service
acceptance, invoice, plus the three conditionals — or state what it should be.

---

## BD-012 · No document type exists for an undertaking or a goods declaration

**ZAM/PUR/SOP-01 Annexure A.** Names "Undertaking (if applicable)" and "GD (if
applicable)".

**Current system.** Neither exists among the thirty seeded document types. The
pack currently points the undertaking at "Other Supporting Document" and the
goods declaration at "Mill / Test Certificate", both labelled as substitutions in
the source reference so the mapping is visible on screen rather than buried.

**Why it matters.** A goods declaration is a customs document and a mill
certificate is a metallurgical one. Filing one under the other means the pack
looks satisfied while holding the wrong paper — which is worse than an empty
slot, because an empty slot is obvious.

**Recommendation.** Add two document types — `UNDERTAKING` and `GD` — with their
own retention and confidentiality settings, then re-run
`scripts/seed-payment-pack.ts`, which repoints the requirements automatically.
Two rows of master data; the reason it is a decision rather than a change is that
somebody should confirm the retention period and who may view them.

**Question.** Approve adding both types, and state their retention period.

---

## BD-013 · The inspection chart does not cover most of what the business buys — **OPEN**

**What the SOP says.** ZAM/PUR/SOP-01's Store Process Flow prints a twenty-one
cell chart: three inspection types by seven category groups, with Store, Admin or
IT in each cell. All twenty-one are now loaded, verbatim.

**The gap the transcription exposed.** The chart's seven columns are
Stationery, Giveaways, Furniture, Housekeeping & Grocery, IT / Network / Mobiles,
Electronic Appliances and Printed Collateral. The system holds seventeen
categories. **Six map onto the chart. Eleven do not:**

| Not on the chart |
|---|
| Construction — Blocks & Masonry, Cement & Aggregate, Steel & Rebar |
| Fit-out & Finishes · HVAC & Air Conditioning |
| Machinery & Equipment · MEP Electrical · MEP Plumbing |
| Safety & PPE · Professional Services · Vehicles & Transport |

That is the construction and MEP side of the business — plausibly the larger
half by value — and the SOP's chart says nothing about who inspects it.

**What the system does about it.** Nothing it was not told to. A category with no
column falls back to the existing template routing, and the inspection screen
says the chart is silent rather than showing an owner. Reading a Store column
across to a steel delivery, because the chart happens to have one, would be
putting words in the SOP's mouth — and it would put a storekeeper's name against
a structural check nobody qualified performed.

**Two chart columns also have no category:** Giveaways and Electronic
Appliances. Adding either category and re-running the seed points it at its
column; no code changes.

**Question.** Who performs the technical, qualitative and quantitative checks on
construction, MEP, machinery, vehicles and safety equipment? Eleven categories
times three checks is thirty-three cells the chart does not contain. Each new row
is a single insert once the answer exists.

