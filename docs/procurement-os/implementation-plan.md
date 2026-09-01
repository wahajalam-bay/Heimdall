# Implementation Plan — Zameen Media

Phases follow the briefed order. Each phase is its own commit series; none is
combined into one large unsafe change.

**Scope discipline.** Before any new workflow or mandatory control goes in, three
questions get answered in writing: is it in ZAM/PUR/SOP-01, is it in the approved
meeting requirements, is it needed to safely support an existing Zameen Media
process. No to all three means it goes to Future Enhancements, not into the build.

## Where the build actually is

147 Zameen Media requirements: **22 implemented · 59 partial · 58 missing · 4
conflict-blocked · 4 not applicable.**

Two phases are complete and pushed. They were done before the Zameen Media
scoping arrived, so each carries a scope note below.

### Phase 1 — Security and data integrity · **COMPLETE** (`ae7fb88`)

| Delivered | Detail |
|---|---|
| Domain authorization | 113 mutating functions in `src/server`; 18 had no check anywhere. **All 113 now authorize inside the domain function.** A test re-runs the sweep against source so a new unchecked mutation fails there |
| The headline hole | `resolveCpcCase` — which approves the award, releases the requisition to PO preparation and marks the comparative approved — was reachable by any signed-in user. `resolveCaseAction` gated on `requireUser()` alone. Same for raising a CPC case, scheduling an inspection, tagging assets |
| `transitionPr` | Validated the state machine and never the mover, and `force: true` (20 of 30 call sites) skipped the machine too. Now requires the authority for the state being entered |
| `transitionPo` | Same treatment. Three call sites needed declared grounds once enforced |
| Authority model | `lib/actor.ts` — permission, cascade (originating permission re-verified), own-record (checked against the row). System principals carry an **empty** permission list and a finite action grant |
| Segregation of duties | Three per-transaction rules, each citing its source, entity-configurable, audited when blocked *and* when waived |
| `Grn.postedById` | Who committed a receipt, distinct from who took delivery |
| Document metadata leak | `listDocuments` was returning name, filename, size and uploader for documents the reader could not open. A filename on a live tender says who is bidding |
| Removed | `actOnApproval`'s dormant `input.system` flag, which could skip the only check separating one approver from another |

**Scope note.** Nothing here is ZD-derived; authorization and atomicity are
properties of the application, not of either SOP.

**Not done:** the required-payment-documents item the briefed Phase 1 includes.
It moves to Phase 2 with the Payment Pack, and needs `SUPABASE_SERVICE_ROLE_KEY`
set first or stored documents vanish on the next deploy.

### Phase 2 — Transaction integrity · **COMPLETE** (`d5137f6`)

| Delivered | Detail |
|---|---|
| Atomicity | **61 functions transactional. There were none.** `postGrn` alone was 16 independently committed writes |
| Idempotency | `postGrn`'s status flip is one conditional `updateMany`, so a double-clicked button cannot double-post stock and price history |
| After-commit work | Three places used a blanket catch inside what is now a transaction — asset tagging, PO closure on final payment, the three-way match. Postgres aborts a transaction on its first failed statement, so a caught error there reports success while the work is discarded. All three deferred |
| Two bugs found | `openBlacklistCase` created the investigation then refused if the user could not suspend, leaving a committed case behind a failed request. `resolveCpcCase` audited its own refusal inside the transaction it was aborting, rolling back the Phase 1 denial record |
| Measured latency | ~1.25 s per query to the database region from a developer machine, ~600 ms inside a pinned transaction. A purchase order issues ~40 statements, so it needs ~25 s. Timeout raised to 120 s and made configurable, and `allocate` no longer queries per line |

**Scope note.** `withTransaction` joins a caller's transaction rather than opening
a second one, so no chain deadlocks against a pool slot its own caller holds.

**Not done:** rollback, duplicate-post and concurrency tests. Verification was
`tsc`, `prisma validate`, a scripted audit proving no write remains outside its
transaction, and the end-to-end acceptance run.

---

## Remaining phases

### Phase 3 — Goods vs Services · **substantially complete**

Everything below is built except controlled PR amendment, which is still free
editing rather than versioning.

The core model change, and the largest single piece of new work.

- `procurementKind` of `GOODS` / `SERVICES` as a first-class classification, not inferred from category names
- Segregation at PR and PO: a Goods PO must not silently carry Services
- A parent relationship so linked Goods and Service documents from one business need stay visible together — the genset oil and its testing service
- Service Acceptance as the counterpart to receiving: Service PO → performed → POC confirmation → accepted / rejected → remarks and evidence → accepted value → invoice eligibility. **Services must not be forced through inventory**
- Tax Master, effective-dated and line-level (**BD-005** supplies the rates)
- GRN control: cumulative accepted quantity may never exceed PO outstanding except through an approved amendment. Partial GRN stays valid
- Invoice auto-population from PO plus posted GRN for goods, from Service Acceptance for services
- Done · Annexure 1's seven missing PR elements, and the form itself — every field printing from the requisition, with the compulsory sign / stamp / date / time taken from the approval attestation rather than the status change
- Done · **The SOP's forms as forms, populated from the chain**: Annexure 1 (requisition), Annexure 2 (petty cash, both approvals and the quotation channel), Annexure 3 (cost analysis), Annexure 4 (inspection note), Annexure 6 (vendor selection), the purchase order as the document that goes to the vendor, the goods receipt note with its whole receiving chain named, and the issuance slip
- Done · **Annexure A stops asking for documents the system wrote.** The pack walks the chain behind an invoice — its order, that order's requisition, the receipts it matched — counts each as held and links its printable form. Holding a document and having checked it stay separate facts. Enforcement (`invoice.enforce_payment_document_pack`) is still off; the three conditional documents need an answer per invoice first
- Open · Controlled PR amendment — versioning rather than free editing

**Preserves:** the inventory-first requirement workflow, and the existing PR↔PO
allocation logic.

### Phase 4 — Inventory and accounting treatment · **substantially complete**

Only the FAR boundary is outstanding, and it depends on **BD-004**.

- Done · Contextual asset vs consumable: Item Master default **plus** transaction-level treatment, so the same AC is an office asset or a project consumable (**BD-002** supplies the policy)
- Done · FIFO cost layers, kept distinct from FEFO physical picking (**BD-008 — closed**). Layers begin on a stated date; nothing before it is restated, no opening layer is invented, and the method ships `WEIGHTED_AVERAGE` so switching changes what future issues cost rather than what past ones did
- Done · Serialised items: one record per received unit, full custody history, no duplicate active serials
- Done · Expiry: tracked where the item or category requires it, with near-expiry alerts
- Done · Inventory ageing, with configurable bands and drilldown to GRN and PO
- Done · Expense Book: asset against consumable by item, category, department, office, project, vendor and period, including overrides and mismatches
- Done · Minimum stock with its SOP basis (§3.3), a consumption-derived suggestion, and the alert the Store Flow requires when the level is reached
- Open · FAR integration boundary. Finance owns the fixed asset register; this links, it does not replace

### Phase 5 — Procurement governance · *in progress*

- Open · Vendor performance rebuilt as its own instrument, never the pre-qualification sheet (**BD-006 still open** — the qualifying score and the instrument are undecided)
- Done · PQ expiry and requalification — **PCZ-01**. Standing, a preview of what any validity would cost before it is set, and a scheduled warning. The switch stays the business's, and can now be flipped with the blast radius on screen
- Open · Temporary blocking with scope, distinct from blacklisting — **PCZ-02**. Blocked on the *grounds*: ZD names three, no ZAM source names any
- Partly · Single sourcing is recorded as a sourcing *basis* with the volume rationale the SOP grounds it on, and an unexplained one is refused. **Dual approval is not built** — the review is recorded by one person
- Done · Emergency procurement as an explicit classification needing exception authority and a substantive reason, recording exactly which policy steps it excused. Grounded in ZAM's own words: "for emergency purchases price competitiveness may not be considered in detail"
- Open · RFQ amendment, cancellation, reissue and versioning; tender via print media
- Done · Negotiation Minutes as a first-class signed record. Participants as rows on both sides, each of §4.5.1's six bases answered, a required conclusion, frozen and hashed on finalising
- Done · PO authorised signatory, distribution evidence, and vendor acknowledgement across the four states. The acknowledgement is a **meeting** requirement, not a ZAM one — see **BD-014**
- Done · Work Orders as their own document, with the Internal Audit gate on Admin services outside CPC's domain
- Done · Contract lifecycle: the CPC mandate's types, twelve states, a notice window, and a sweep that never auto-renews

### Phase 6 — Store and asset operations · *in progress*

- Done · Inspection responsibility matrix — all 21 chart cells, each check signed separately, and the inspection refused closure while one is blank. The chart covers 6 of 17 system categories — see **BD-013**
- Done · Annexure 4 built to `image17.png`, with both signature blocks. The department block routes to the requisition's POC and refuses the inspector
- Done · Failed inspection creating or linking an RTV without re-entry
- Done · Issuance slip signed by the receiver, or a paper slip recorded and labelled as a transcription
- Open · Gate pass auto-populated from the PO; outward passes linked to disposal
- Done · Stock count and cycle count: sheets with a frozen expected quantity, variance with a reason, review by somebody other than the counter, and adjustment through the same ledger as every other movement
- Done · Employee return: Store Receiving Note, IT-only inspection decided from the category, Repair & Maintenance hand-off with a reference, and only stacked lines going back into stock
- Done · Disposal: all eight Scrap Material Policy stages with their evidence — inspection report, photographs, Finance's depreciated and residual values, the insignificant-value route naming the head consulted, five named witnesses at the sale, and the FAR hand-off
- Done · Loss and theft, kept apart from adjustments, with unexplained shortage as its own honest kind and the write-off deliberately separate from the report

### Phase 7 — Integration

- Sage adapter: external ids, sync metadata, outbox, retry, error queue, reconciliation screen, test stub. Live mapping marked **BLOCKED BY SAGE API SPEC/CREDENTIALS** (**BD-004**)
- JEFFI — nothing built until defined (**BD-003**)
- Finance and FAR interfaces

### Phase 8 — Governance platform · *substantially complete*

- Done · Alert engine: exceptions gained acknowledgement (separate from resolution) and escalation up the organogram's own reporting line, with un-escalatable cases reported rather than silently marked
- Done · Control calendar — ten controls, each citing its clause. A run exists for the period, so a control nobody performed is a row with nothing in it
- Done · Segregation-of-duties report showing who holds both sides of each separation, extending Phase 1's per-transaction enforcement
- Open · Conflict of interest, gifts, confidentiality, NDA — registers with no ZAM grounding and no operational consequence yet
- Done · Delegation and proxy: dated, scoped, lent-never-invented, and both names on every act
- Done · Policy acknowledgement tied to the exact version, with the register resetting on publication
- Done · Quarterly access review as a decision record, capturing the figures as they stood
- Open · Annual compliance audit; system interface testing
- Done · Attestation engine (`server/attestation.ts`), used by inspections, issuance slips, Annexure 4, negotiation minutes and work orders
- Done · PO splitting detector producing a compliance case, not an alert — and excluding orders already referred to committee or arising from one requisition

### Phase 9 — Planning and project processes

- MRP: budget revision, BOQ, planned quantity and cost, required period, actual PR/PO/receipt, variance, quarterly revision
- Demand forecasting from consumption history — suggestions only
- Requirement consolidation before sourcing
- Done · Monthly repeat orders producing **draft** requirements, projected from consumption less stock on hand and quantities already on order, never auto-submitted
- Build-outs, reusing existing Projects, Sites, Budgets, PRs and POs
- RNC as its own committee, with regions and its own quorum (**PCZ-10**)

### Phase 10 — Analytics and performance

- Monthly reporting pack, consumable inventory report, inventory ageing, Expense Book
- Compliance metrics
- N+1 pass. `allocate` was fixed in Phase 2 because it was inside a transaction; the rest of the audit's findings remain

---

## Policy version on every transaction

Required from Phase 3 onward, and retrofitted where cheap:

```
policyDocument = ZAM/PUR/SOP-01
policyVersion  = 01
entity         = Zameen Media
effectiveConfiguration = snapshot of the rules that governed this transaction
```

ZD rules never populate this. A historical transaction keeps the version that
governed it, so a later policy change never rewrites what was decided.

## Future enhancements

Not built in this release, recorded so the reading is not lost: the 96 ZD-only
requirements in Appendix A of the source-to-system matrix, the ZD nine-document
payment chain, and ZD's own blacklisting grounds.
