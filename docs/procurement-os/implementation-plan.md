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

### Phase 3 — Goods vs Services  · *next*

The core model change, and the largest single piece of new work.

- `procurementKind` of `GOODS` / `SERVICES` as a first-class classification, not inferred from category names
- Segregation at PR and PO: a Goods PO must not silently carry Services
- A parent relationship so linked Goods and Service documents from one business need stay visible together — the genset oil and its testing service
- Service Acceptance as the counterpart to receiving: Service PO → performed → POC confirmation → accepted / rejected → remarks and evidence → accepted value → invoice eligibility. **Services must not be forced through inventory**
- Tax Master, effective-dated and line-level (**BD-005** supplies the rates)
- GRN control: cumulative accepted quantity may never exceed PO outstanding except through an approved amendment. Partial GRN stays valid
- Invoice auto-population from PO plus posted GRN for goods, from Service Acceptance for services
- Annexure 1's seven missing PR elements, and controlled amendment rather than free editing

**Preserves:** the inventory-first requirement workflow, and the existing PR↔PO
allocation logic.

### Phase 4 — Inventory and accounting treatment

- Contextual asset vs consumable: Item Master default **plus** transaction-level treatment, so the same AC is an office asset or a project consumable (**BD-002** supplies the policy)
- FIFO cost layers, kept distinct from FEFO physical picking (**BD-008**)
- Serialised items: `isSerialised` on Item Master, one record per received unit, full custody history, no duplicate active serials
- Expiry: tracked where the item or category requires it, with near-expiry alerts
- Inventory ageing, with configurable bands and drilldown to GRN and PO
- Expense Book: how much was treated as asset, how much as consumable, by item, category, department, office, project, vendor, period — including overrides and mismatches
- FAR integration boundary. Finance owns the fixed asset register; this links, it does not replace

### Phase 5 — Procurement governance

- Vendor performance rebuilt as its own instrument, never the pre-qualification sheet (**BD-006**)
- PQ expiry and requalification — **PCZ-01**, required by meeting requirement 20
- Temporary blocking with scope, distinct from blacklisting — **PCZ-02**
- Single Source as a workflow with market evidence and dual approval, not "quotation count = 1"
- Emergency procurement as an explicit classification with its own evidence
- RFQ amendment, cancellation, reissue and versioning; tender via print media
- Negotiation Minutes as a first-class signed record, not negotiation rows
- PO: authorised signatory, legal terms, vendor acknowledgement with `ACKNOWLEDGED` / `REJECTED` / `NO_RESPONSE` / `DEEMED_ACCEPTED_THROUGH_EXECUTION`, distribution evidence
- Work Orders as their own document, with the Internal Audit gate for Admin services
- Contract lifecycle: types, twelve states, expiry alerts

### Phase 6 — Store and asset operations

- Inspection responsibility matrix from the SOP — 21 category × type × owner assignments, replacing one generic `GENERAL` inspection
- Annexure 4 built to `image17.png`, with both sign-off blocks
- Failed inspection creating or linking an RTV without re-entry
- Gate pass auto-populated from the PO; outward passes linked to disposal
- Stock count and cycle count: sheets, variance, reason, approval, adjustment, audit sign-off
- Employee return: Store Receiving Note, conditional IT inspection, R&M handoff, custodian clearance
- Disposal with net book value, Finance valuation gate, witnesses, pictorial evidence, IA conclusion
- Loss and theft reporting

### Phase 7 — Integration

- Sage adapter: external ids, sync metadata, outbox, retry, error queue, reconciliation screen, test stub. Live mapping marked **BLOCKED BY SAGE API SPEC/CREDENTIALS** (**BD-004**)
- JEFFI — nothing built until defined (**BD-003**)
- Finance and FAR interfaces

### Phase 8 — Governance platform

- Alert engine: persisted records with owner, due date, acknowledgement, escalation, resolution
- Control calendar for the recurring controls
- Segregation-of-duties configuration and report, extending what Phase 1 built
- Conflict of interest, gifts, confidentiality, NDA
- Delegation and proxy, provable rather than "someone else holds the permission"
- Policy acknowledgement tied to the exact version
- Quarterly access review as a decision record
- Annual compliance audit; system interface testing
- Attestation engine, replacing scattered signature fields
- PO splitting detector producing a compliance case, not an alert

### Phase 9 — Planning and project processes

- MRP: budget revision, BOQ, planned quantity and cost, required period, actual PR/PO/receipt, variance, quarterly revision
- Demand forecasting from consumption history — suggestions only
- Requirement consolidation before sourcing
- Monthly repeat orders producing **draft** requirements, never auto-approved
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
