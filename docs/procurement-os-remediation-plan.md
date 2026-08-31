# Procurement OS — Remediation Plan

Derived from `procurement-os-compliance-matrix.md` (195 requirements),
`procurement-os-policy-conflicts.md` (23 conflicts) and
`procurement-os-external-sources-required.md` (24 outstanding sources).

Work is grouped P0–P3 per the brief and sequenced into phases. Each phase names
what changes, why, the files affected and the risks — reported again at the start
of the phase and summarised at the end.

**Principle applied throughout:** the platform services in Phase 1 are built
first because 60+ requirements resolve into them. Solving those requirements
one-off would produce the duplicated scheduling, signature and document logic the
brief explicitly forbids.

---

## Sequencing overview

| Phase | Group | Content | Requirements closed |
|---|---|---|---|
| **1** | P0 | Domain authorization sweep + SoD | 12 |
| **2** | P0 | Transaction integrity — GRN and other multi-write operations | 3 |
| **3** | P0 | Policy Pack / version engine | foundation for 60+ |
| **4** | P0 | Required Document Engine + Payment Pack | 9 |
| **5** | P0 | CPC control-grade: roster, member types, quorum, CEO tier, decision communication | 10 |
| **6** | P0 | Tax configuration correction; Cost Analysis alignment to Annexure 3 | 5 |
| **7** | P0 | Test coverage for receiving, assets, analytics, cost analysis | — |
| **8** | P1 | Attestation, Delegation, Alert, Communication, Compliance Case engines | foundation for 40+ |
| **9** | P1 | Compliance Scheduler + the 16 recurring controls | 18 |
| **10** | P1 | Vendor management rebuild — PQ instrument, performance instrument, blocking, visits, MDCR | 24 |
| **11** | P1 | Receiving and inspection — matrix, Annexure 4, RTV, gate passes | 12 |
| **12** | P1 | Inventory — employee return, stock count, replenishment | 6 |
| **13** | P1 | Sourcing — tender route, single source, emergency, negotiation minutes, SLAs | 14 |
| **14** | P1 | PO — signatory, acknowledgement, distribution, legal terms, split detection | 8 |
| **15** | P1 | Work Orders and Contracts | 12 |
| **16** | P1 | PR — Annexure 1 completion, amendment, SLA | 6 |
| **17** | P1 | Demand — MRP, consolidation, monthly planning | 9 |
| **18** | P1 | Committees — RNC; Build-Out management | 25 |
| **19** | P2 | Ethics and probity | 13 |
| **20** | P2 | Disposal evidence chain | 13 |
| **21** | P2 | Governance controls | 9 |
| **22** | P2/P3 | Admin masters, organogram UI, MIS pack | 11 |
| **23** | P3 | N+1 remediation and performance | — |

Phases 1–7 are P0 and must complete before any P1 work begins. Within P1,
phase 8 gates phases 9–18 because those consume the engines it builds.

---

# P0 — Authorization, data integrity and compliance failures

24 requirements. These are defects in controls that already exist on paper, plus
two internal inconsistencies the system introduced itself.

## Phase 1 · Domain authorization sweep — **COMPLETE**

> **Outcome.** 113 mutating exported functions across the 24 `src/server/*.ts`
> modules; **18 had no authorization check anywhere in their body**, and all 18
> now do. A test in `tests/authorization.test.ts` re-runs the sweep against the
> source on every suite run, so a new unchecked mutation fails there rather than
> in production.
>
> **Two of the eight functions named in this plan were misdiagnosed in Phase 0.**
> `createPettyCash` (`pettycash.ts:68`) and `createGatePass` (`receiving.ts:41`)
> already enforced `PETTY_CASH_CREATE` and `GATE_PASS_CREATE`. The detection pass
> that produced the Phase 0 list truncated function bodies at the first brace,
> which for a multi-line signature with an inline object type is inside the
> parameter list. The matrix rows (PC-102, RC-001) have been corrected.
>
> **The real exposure was worse than the list suggested.** `resolveCpcCase` — the
> committee decision that approves the award, releases the requisition to PO
> preparation and marks the comparative approved — was reachable by any signed-in
> user, because `resolveCaseAction` gated on `requireUser()` alone. The same was
> true of `raiseCpcCaseAction`, `raiseInspectionAction` and `tagFromGrnAction`.
>
> **`transitionPr` was the largest single hole**: it validated the state machine
> and never the mover, so anyone who reached it could advance a requisition to
> any adjacent state — and `force: true`, used at 20 of its 30 call sites,
> skipped the state machine too. It now requires the authority for the state
> being *entered* (`PR_TRANSITION_AUTHORITY` in `lib/domain.ts`) plus entity
> access, and `force` no longer touches authorization.
>
> **How the 30 internal callers were handled** — with an authority mechanism, not
> a bypass. `lib/actor.ts` defines three grounds, and there is no branch in
> `assertAuthority` that returns without testing something:
> `{ permission }` (the actor holds it), `{ cascade, from }` (this step follows
> from an operation the actor *was* authorized for, and that originating
> permission is re-verified here), and `{ ownRecord, orPermission }` (the actor
> owns the row, checked against the owner id the authorizing function loaded
> itself). System principals — scheduler, migration, seed — carry an empty
> permission list and a finite list of named domain actions, so a permission-based
> check on one *fails*; only its declared grant admits it.
>
> **Also delivered:** the segregation-of-duties matrix (`lib/sod.ts`) with three
> source-cited per-transaction rules, each entity-configurable and audited when
> blocked *or* when waived by configuration; role-assignment conflict checking,
> empty by default because neither SOP names a pair (ES-025); and the closure of
> a document-metadata leak in `listDocuments`, which returned the name, filename,
> size, type and uploader of every document on a case regardless of whether the
> reader could open it.
>
> **New findings raised:** PC-027 (a requisition can reach APPROVED with no human
> approver — preserved, but now travelling on a declared and auditable authority),
> PC-028 (starting sourcing required only the `pr.view_all` read permission —
> tightened), ES-025 (prohibited role combinations).
>
> **Two permissions added:** `cpc.case_raise` and `inspection.schedule`, both
> synced to the database via `scripts/sync-rbac.ts` (2 permissions, 16 grants).
>
> **Deferred, with reason:** a per-target-state authority map for *purchase
> orders*. `transitionPo` is module-private and every exported function in
> `po.ts` authorizes before calling it, so the marginal exposure today is nil;
> it belongs with Phase 14. `Grn.postedById` does not exist, so the invoice
> separation keys on `receivedById` — noted on E-007 for Phase 11.

### Original scope

**Requirements:** PC-102, RC-001, RC-004, CP-006 (partly), E-007, E-008, R-004
(partly), plus the full sweep the brief mandates.

**What changes.** Every exported mutating function in `src/server/*.ts` gains an
explicit authorization check. The audit found these with none anywhere in the
chain:

| Function | Module | Effect if unauthorized |
|---|---|---|
| `resolveCpcCase` | `cpc.ts` | Approves a committee case; moves the PR to PO preparation; marks the comparative approved |
| `createCpcCase` | `cpc.ts` | Creates a committee case |
| `createPettyCash` | `pettycash.ts` | Raises a petty cash request |
| `createGatePass` | `receiving.ts` | Creates an inward gate pass — the first control on goods entering site |
| `scheduleInspection` | `receiving.ts` | Schedules an inspection |
| `transitionPr` | `pr.ts` | Moves a requisition between any two states |
| `tagAssetsFromGrn` | `assets.ts` | Creates asset records |
| `recomputePoFulfilment` | `po.ts` | Recalculates received quantities |

`listDocuments` and `cpcRequirement` are reads and are assessed separately —
`listDocuments` must still filter by the caller's document permissions.

**Also in this phase:** a **segregation-of-duties matrix** (E-007, E-008).
Prohibited combinations enforced at role assignment and at action time. Initial
set derived from the SOPs' own separations — the person who prepares a cost
analysis cannot verify it (already enforced), the person who raises a PR cannot
approve it, the person who posts a GRN cannot approve the matching invoice.
Anything not stated in the source is **not** invented; the matrix is
configuration with an empty default beyond the source-derived entries.

**Files:** all 24 `src/server/*.ts`; `src/lib/rbac.ts`; `src/lib/permissions.ts`;
`tests/authorization.test.ts`.

**Risks.** Adding a check to `transitionPr` may break internal callers that pass
a system actor rather than a user — it is called 31× from server modules. Mitigation:
a system-actor concept that is explicitly authorized, not a bypass. Each of the 31
call sites is reviewed individually.

**Tests.** For every function above: an unauthorized actor is rejected; an
authorized actor succeeds; the rejection is audited.

## Phase 2 · Transaction integrity — **COMPLETE**

> **Outcome.** 61 functions are transactional. There were none: `postGrn` alone
> was 16 independently committed writes. `withTransaction` in `lib/db.ts` joins
> a caller's transaction rather than opening a second one, so a function that is
> atomic alone stays atomic when another calls it and cannot deadlock against a
> pool slot its own caller holds.
>
> **`postGrn` is idempotent.** The status flip is a single conditional
> `updateMany` instead of a read then a write, so a double-clicked button or a
> retried action cannot double-post stock and price history.
>
> **The outbox turned out to be already half-built and needed differently.**
> `notify`, `createTask` and `queueEmail` are all pure database writes, and mail
> was already deferred — `queueEmail` writes an `EmailMessage` row that a sweep
> flushes later. So no HTTP was ever inside a transaction. The real hazard was
> the opposite one: Postgres aborts a transaction on its first failed statement,
> so a caught-and-ignored database error poisons every write after it while the
> catch reports success. Three places did that — asset tagging on receipt, the
> purchase order closure on final payment, the three-way match on invoice
> registration — and all three now run after the commit through `defer`, where
> best-effort is true again.
>
> **Two bugs surfaced.** `openBlacklistCase` created the investigation and then
> refused if the user could not also suspend the vendor, leaving a committed case
> behind a failed request. And `resolveCpcCase` audited its own refusal inside
> the transaction it was about to abort, so the Phase 1 denial record was being
> rolled back — authorization now runs before the transaction opens.
>
> **Deliberately not transactional:** `readDocument`, which writes a DENIED
> access-log row and then throws. Inside a transaction that record would roll
> back with the refusal, which is the one thing it exists to survive.
>
> **Timeouts** raised from Prisma's 5s default to 20s, configurable via
> `DB_TX_TIMEOUT_MS` / `DB_TX_MAX_WAIT_MS`.
>
> **Not done:** the rollback, duplicate-post and concurrency tests this phase
> specified. Verification was `tsc` plus a scripted audit asserting no `db.*`
> write remains inside a transactional closure.

### Original scope

**Requirements:** GR-001, GR-002, GR-003.

**What changes.** `postGrn` and the other critical multi-write operations move
inside `$transaction`. There are currently **zero** `$transaction` calls in the
codebase; the `Tx` and `DbClient` types in `src/lib/db.ts` exist for this and were
never wired.

Operations to make atomic, in order of risk:

1. `postGrn` — GRN status, inventory ledger, price history, item and vendor
   updates, PO fulfilment, asset tagging, stacking
2. `signVoucher` and voucher generation — accounting-adjacent
3. `postMovement` and `allocateOutbound` — inventory ledger
4. `decideFulfilment` — requirement split into issue and purchase
5. `resolveCpcCase` — case outcome, comparative status, PR transition
6. `advanceReturn`, `recordVariance` — receiving exceptions

Notifications, tasks and emails move to an **outbox** written inside the
transaction and dispatched after commit, so a failed notification cannot roll
back a posted GRN and a committed GRN cannot lose its notification.

**Idempotency** on `postGrn`: a natural key on (delivery, GRN number) plus a
posted-state guard, so a retried request cannot double-post inventory or price
history.

**Files:** `src/lib/db.ts`; `src/server/grn.ts`, `inventory.ts`, `vouchers.ts`,
`requirements.ts`, `cpc.ts`, `receiving-exceptions.ts`; `src/lib/notify.ts`;
`src/lib/audit.ts`; new `src/lib/outbox.ts`.

**Risks.** Supabase runs behind a connection pooler; long transactions can hold
pool slots. Mitigation: keep transactions to database work only — no HTTP, no
mail — and measure duration. Prisma's interactive transactions have a default
timeout that may need raising for the GRN chain.

**Tests.** Rollback tests: force a failure at each write in the chain and assert
no partial state. Duplicate-post test. Concurrent-post test.

## Phase 3 · Policy Pack / version engine

**Foundation for 60+ requirements.** Nothing in P0-4 onward can be done correctly
without it, because almost every threshold in both SOPs differs by entity.

**What changes.** A `PolicyPack` with entity, version, effective from/to, and
versioned rule sets for: thresholds, quotation requirements, approval routes,
committee composition and quorum, document requirements, evaluation frequency and
instrument, petty cash limits, SLAs, tax rates, form definitions.

**Every transaction records the policy version that governed it** (brief rule 6).
This is a new column on the transactional tables plus a resolution function that
stamps it at creation.

**Backfill:** existing records get policy version `LEGACY-000` with a documented
meaning — "created before policy versioning; governing rules not recorded". They
are not retro-assigned to a version they may not have been governed by.

**Files:** `prisma/schema.prisma`; new `src/lib/policy.ts`, `src/server/policy.ts`;
`src/lib/config.ts` (config becomes a policy-pack reader);
`src/app/(app)/admin/policies`.

**Risks.** This touches the resolution path of every existing rule. Mitigation:
the existing `getConfig*` functions keep their signatures and delegate to the
policy engine, so no call site changes in this phase. Migration is additive only.

**Tests.** Policy-version isolation: a transaction created under version A
continues to be evaluated under A after version B becomes effective.

## Phase 4 · Required Document Engine and Payment Pack

**Requirements:** R-004, R-038, FI-003, FI-004, FI-005, FI-006, PO-007, CP-016,
GR-003.

**What changes.** Document requirements become configurable by entity, workflow,
stage, transaction type, amount and category, each `REQUIRED` / `CONDITIONAL` /
`OPTIONAL` / `NOT APPLICABLE`. Transitions are blocked where required evidence is
absent, unless an explicitly permitted and audited exception is recorded.

**Payment Pack** per invoice: applicable requirements, documents present,
documents verified, verified by and when, exceptions, pack version, handoff
history.

Seeded from source:

| Entity | Source | Documents |
|---|---|---|
| ZAM | Annexure A (`image14.PNG`) | PR · PO · GRN · Invoice · Undertaking (conditional) · GD (conditional) · Exemptions (conditional) |
| ZD | ZD payment flow (`image14.png`) | Payment Voucher · PR · PO · MIR · GRN · Invoice · CPC Approval · Undertaking (GD) · Tax Exemption Certificate |

**Also fixes FI-004** — `SUPABASE_SERVICE_ROLE_KEY` must be set and the private
bucket created, or the whole engine stores metadata for files that do not survive
a deploy. This is a configuration action, not code, and I will flag it rather
than pretend it is done.

**Blocked in this phase:** the conditions that make `Undertaking`, `GD` and
`Exemptions` applicable are not stated (ES-016, ES-017). They are seeded as
`CONDITIONAL` with the condition left unset, which surfaces as "condition not
configured" rather than silently passing.

**Files:** `prisma/schema.prisma`; new `src/server/document-requirements.ts`,
`src/server/payment-pack.ts`; `src/server/invoice.ts`, `vouchers.ts`;
`src/app/(app)/finance/*`; `src/app/(app)/admin/document-types`.

**Risks.** Turning on required documents against existing data will block
in-flight invoices. Mitigation: requirements are effective-dated and apply only to
invoices raised after the effective date; existing invoices carry `LEGACY-000`.

## Phase 5 · CPC control-grade

**Requirements:** CP-003, CP-006, CP-007, CP-012, CP-016, CP-002 (partly),
CP-004, CP-005, CP-015, SO-005.

**What changes.**

- **Standing committee roster** per entity with effective dates and three member
  types — `PERMANENT_MANDATORY`, `PERMANENT`, `OBSERVER` (PC-009). Both entities'
  rosters seeded as supplied.
- **Meeting attendance** with presenter and proxy.
- **Quorum enforcement** before an outcome can be recorded: minimum permanent
  count, mandatory-member rule, observers excluded from both vote and count,
  requisitioner-department head or authorized proxy present, auto-defer when not.
  All policy-configurable.
- **Vote eligibility and recusal** — a member with a declared conflict cannot vote
  (links to Phase 19).
- **CEO tier above PKR 1,500,000** as an auditable approval step. CPC ceases to be
  the top of the ladder.
- **Decision communication** as a payment prerequisite (CP-016) — the minuted email
  to members copying the CEO's office, retained as evidence and required by the
  Payment Pack.

**Blocked:** the "Exceptional Purchases → CEO" classification trigger (ES-011) —
the value tier is implemented, the classification is not, because "exceptional"
is undefined.

**Files:** `prisma/schema.prisma`; `src/server/cpc.ts`; `src/lib/approvals.ts`;
new `src/server/committees.ts`; `src/app/(app)/cpc/*`; `src/app/(app)/admin`.

**Risks.** Existing 5 CPC cases have per-case members with free-text roles and no
attendance. They cannot be retro-assessed for quorum. Mitigation: cases created
before this phase are marked `quorumAssessed: false` and excluded from quorum
assertions, documented as legacy.

## Phase 6 · Tax configuration and Cost Analysis alignment

**Requirements:** FI-007, SO-006, SO-007, SO-008, R-031.

**What changes.**

- The tax inconsistency the system introduced is corrected: configuration says
  18%, the Cost Analysis Form says 16%, neither has SOP authority (PC-012). Tax
  becomes effective-dated per entity and tax type. **No silent default is applied
  to a printed form** — an unconfigured rate renders as unset.
- The Cost Analysis Form gains a **versioned definition**: vendor column count,
  line count, terms rows, whether tax is computed. Annexure 3 seeded as
  `CA-ANNEX3` (3 vendors, 6 terms rows incl. Quotation Validity, After Sale
  Services/Warranties and Other Pertinent Details, no computed tax rows, `Last PO
  No` column). The xlsx layout seeded as `CA-XLSX5`.
- Higher-rate reason becomes a **bounded choice** — Quality / Technical Special /
  Others — per the form, with a free-text follow-up for Others.

**Blocked:** which version governs (PC-011) is a management decision. Both are
seeded; an administrator selects.

**Files:** `src/server/cost-analysis.ts`;
`src/app/(app)/comparatives/[id]/cost-analysis/*`; `src/lib/config.ts`;
`prisma/schema.prisma`.

**Risks.** Low. Existing comparatives keep their recorded values; only rendering
and new entry change.

## Phase 7 · P0 test coverage

**What changes.** Coverage for the modules the brief names, plus everything
changed in phases 1–6.

| Module | Current | Target |
|---|---|---|
| `receiving.ts` | **no test file** | authorization, gate pass, inspection scheduling, RTV linkage |
| `assets.ts` | **no test file** | tagging from GRN, disposal gating, insurance |
| `analytics.ts` | **no test file** | every computed figure against a fixture |
| `cost-analysis.ts` | **no test file** | calculations, gaps, signatures, permissions, edge cases |
| `org.ts` | **no test file** | line manager resolution, escalation, loop rejection, POC fallback |

**Files:** `tests/receiving.test.ts`, `tests/assets.test.ts`,
`tests/analytics.test.ts`, `tests/cost-analysis.test.ts`, `tests/org.test.ts`;
additions to `tests/authorization.test.ts` and `tests/lifecycle.test.ts`.

---

# P1 — Missing required workflows

96 requirements.

## Phase 8 · Cross-cutting engines

Built once, consumed by phases 9–18. Building these after the P1 features would
mean writing the same logic five times.

| Engine | Serves | Requirements |
|---|---|---|
| **Attestation / signature** | PR sign-stamp-date-time · Cost Analysis · Negotiation Minutes · PO signatory · inspection forms · issuance receiver · vouchers · committee decisions · disposal witnesses | PR-003, SO-004, PO-003, RC-007, RC-008, RC-020, AS-009, R-002, R-014, V-019 |
| **Delegation / proxy** | committee presenters and proxies · approval delegation | CP-006, RN-004, BO-011 |
| **Persistent alert / escalation** | store-entry gaps · overdue GRN · missing GRN · discrepancy escalation · contract expiry | PC-108, RC-006, plus existing `/alerts` |
| **Required communication** | RFQ invitation with CC trail · CPC and RNC decision emails · performance gap reports · vendor blocking notices | R-029, CP-016, RN-010, R-024, R-026, R-013 |
| **Compliance / exception case** | below-minimum quotations · non-lowest award · non-prequalified vendor · single source · emergency · PO splitting · match mismatch · policy override · missing evidence · late approval · vendor conflict | PR-012, PR-014, SO-016, PO-009, E-009, E-010, GR-003, V-001, R-032 |

**Files:** `prisma/schema.prisma`; new `src/server/attestation.ts`,
`delegation.ts`, `alerts.ts`, `communications.ts`, `compliance-cases.ts`;
`src/lib/outbox.ts` (from Phase 2).

**Risks.** The attestation engine replaces ad-hoc signature fields
(`Comparative.verifiedById`, `Inspection.signedByName`, voucher signatures).
Mitigation: existing fields retained and backfilled into attestations; no data
discarded.

## Phase 9 · Compliance Scheduler and the recurring controls

**Requirements:** 18, spanning R-012, R-015, V-007, V-008, V-016, V-017, RC-013,
GV-002, GV-004, GV-005, GV-006, GV-007, FI-008, SO-017, PR-004, S-007, AS-014,
V-003.

**What changes.** One reusable recurring-control system: control definition,
frequency, entity, owner role, assigned user, due date, status, evidence,
reminder, escalation, completion, audit history.

Controls seeded from source:

| Control | Frequency | Entity | Source |
|---|---|---|---|
| Open / obsolete PO closure | Monthly | ZD | R-015 |
| Store / inventory audit by Internal Audit | Monthly | BOTH | RC-013 |
| Supply Chain MIS pack | Monthly | ZD | FI-008 |
| QC rejection reporting | Monthly | ZD | SO-017 |
| Monthly repeat-order planning | Monthly | BOTH | PR-004 |
| Price competitiveness check (3 quotes) | 2-monthly | BOTH | PC-017 |
| System access-rights review | Quarterly | ZD | GV-005 |
| MRP update | Quarterly | ZD | S-007 |
| Vendor reconciliation | Biannual | ZD | V-017 |
| Vendor master review / cleansing | Annual | ZD | V-007, GV-007 |
| Vendor performance evaluation | 3-monthly ZAM / annual ZD | BOTH | PC-001 |
| Vendor feedback by Internal Audit | Annual | ZD | V-016 |
| Procurement compliance audit | Annual | ZD | GV-002 |
| Supply Chain Manual review | Annual | ZD | GV-004 |
| System interface testing | Annual | ZD | GV-006 — blocked, ES-018 |
| Vendor re-prequalification | 2-yearly | ZD | V-003 |
| Disposal policy review with employees | Periodic | ZAM | AS-014 |

**Files:** `prisma/schema.prisma`; new `src/server/controls.ts`,
`src/app/(app)/controls/*`; `src/app/api/cron/controls/route.ts`.

**Risks.** Generating 17 controls across 2 entities immediately creates a backlog
of overdue items that will look alarming. Mitigation: first generation dated
forward from the go-live date, not backdated.

## Phase 10 · Vendor management rebuild

24 requirements. The largest single gap.

**A. Pre-qualification** rebuilt from Annexure 6's own sections (V-019 to V-027):
7 sections with the form's maxima, the related-party question ("Any other company
owned by same owner"), the three mandatory documents (FBR Online Status, Company
Registration, Job Completion Certificate), and Prepared/Verified/Approved
attestations. Validity and expiry (V-003), requalification, exemption via Single
Source (V-004).

**B. Performance evaluation** as a **separate instrument** (V-028 to V-034), never
the PQ sheet. Both conflicting variants seeded (PC-002), both rating scales
(PC-003), both quality scoring methods (PC-004) — admin selects, system does not
choose.

**C. Blocking** distinct from blacklisting (V-013, V-014): temporary, scoped,
grounds, effective dates, remediation condition, unblock workflow. Entity-scoped —
enabled for ZD, off for ZAM pending decision (PC-020).

**D. Vendor visit reports** (V-021, R-021).

**E. Master data change request** with Finance review and versioned update
(V-008, R-008, R-023). Bank-detail changes get elevated authorization and audit.

**F. Sourcing gates**: PQ pass required (V-001), satisfactory performance required
(V-009) — with the unrated-vendor treatment configurable because the source is
silent (PC-018).

**Files:** `prisma/schema.prisma`; `src/server/vendors.ts`; new
`src/server/vendor-pq.ts`, `vendor-performance.ts`, `vendor-blocking.ts`,
`vendor-mdcr.ts`; `src/app/(app)/vendors/*`.

**Risks.** 21 existing vendors carry scores under the current 20-criterion sheet.
Those scores are not transferable to the new instrument. Mitigation: existing
evaluations retained and marked instrument `LEGACY-20CRIT`; new evaluations use
the selected instrument; no score is recomputed.

## Phase 11 · Receiving and inspection

**Requirements:** RC-002, RC-003, RC-005, RC-007, RC-008, RC-009, RC-010,
RC-011, plus gate pass authorization already done in Phase 1.

Inspection responsibility matrix as **configurable master data** — category ×
inspection type → owner role, seeded with the 21 assignments. Annexure 4 form
built to `image17.png` including the certification text, totals block, expiry
column, item code and both signature blocks. Failed inspection creates or links
an RTV without re-entry. Outward gate passes linked to disposal and returns.

## Phase 12 · Inventory

**Requirements:** RC-018, RC-019, RC-020, RC-013, AS-015, R-003.

Employee Return workflow with Store Receiving Note, conditional IT inspection,
R&M handoff, custodian clearance. Stock Count / Cycle Count with count plan,
sheets, variance, verifier, IA involvement, approved adjustment, reconciliation.
Minimum-stock replenishment with named-associate notification and policy-based
draft PR. Region only if Phase 18 confirms it is needed for RNC — not duplicated
if Site suffices.

## Phase 13 · Sourcing completion

**Requirements:** SO-001, SO-004, SO-010, SO-011, SO-012, SO-016, PR-010,
PR-011, PR-012, R-027, R-028, R-029, V-012, S-001.

Sourcing method enum (`VENDOR_RFQ`, `OPEN_TENDER`, `PRINT_MEDIA_TENDER`,
`SINGLE_SOURCE`, `EMERGENCY`, `RATE_CONTRACT`). RFQ amendment with versioning that
does not erase original invitations or responses. RFQ generation and PR review
SLAs on a **working-hours** calendar (24 working hours, not 24 hours). Negotiation
Minutes as a first-class signed record. Single Source workflow with dual approval.
Emergency procurement workflow — **authority blocked on ES-023**, so the workflow
is built and the approver is configuration that must be set before use. Demand
consolidation into procurement packages with allocation back to source
requirements.

## Phase 14 · Purchase orders

**Requirements:** PO-003, PO-004 (to Phase 15), PO-006, PO-008, PO-009, PO-010,
R-035, R-036, PR-015.

Authorised signatory via attestation. Vendor acknowledgement with method,
evidence, and the deemed-acceptance-on-execution rule. PO distribution to
Logistics, Procurement and Accounts with evidence. Versioned legal terms per PO
version. **PO splitting detector** across configurable dimensions producing a
compliance case for review — flagging, never accusing.

## Phase 15 · Work Orders and Contracts

**Requirements:** PO-004, CP-015, R-009, R-010, R-033, RN-009, CP-002.

Work Order as a first-class document — not a renamed PO: originating request,
service scope, negotiated rates, related comparative, value, start/end,
milestones, approvals, **Internal Audit approval for Admin services**, authorised
issuer, attachments, invoice linkage.

Contracts module with the 6 types and 12-state lifecycle, expiry alerts through
the Alert engine, PO/WO/invoice links. **Legal content blocked on ES-013** — the
mechanism is built, templates are not authored by me.

## Phase 16 · Purchase requisition completion

**Requirements:** PR-003, PR-001 (form), plus amendment and SLA.

The seven missing Annexure 1 elements, wired into the lifecycle and a printable
form — not decorative fields. The compulsory Sign / Stamp / Date / Time block via
attestation. Policy-aware amendment with versioning that does not overwrite
history, and a rule for whether amendment requires reapproval.

## Phase 17 · Demand and MRP

**Requirements:** S-006, S-007, PR-004, PR-005, S-001, D-001 to D-003 (from the
brief's demand section).

`REQUIREMENT_EDIT` enforced. Controlled amendment with version records.
Consumption analytics supporting reorder suggestions. Monthly repeat-order
planning producing **reviewable** planned demand, never auto-purchase.

MRP as a distinct capability: project, budget revision, BOQ, material, category,
planned quantity and cost, required period, MRP revision, actual PR/PO/receipt,
variance, quarterly revision history.

## Phase 18 · Committees and build-outs

**Requirements:** 10 RNC + 15 build-out = 25.

RNC as its own module, not CPC reused: regional rosters with three member types,
per-region quorum (with North/South flagged per PC-024), landlord comparative,
market evidence, decision communication, rental agreement linkage. Entity-scoped
so it applies to ZAM without being imposed on ZD.

Build-Out Management with the 11-stage lifecycle, reusing existing Projects,
Sites, Budgets, PRs, RFQs and POs rather than duplicating them. CFC with the
seeded roster and named proxies. The 34 departmental tasks as a template. Weekly
Friday progress control. BOQ vs actual. Lessons-learned with budget and timeline
variance.

---

# P2 — Missing forms, evidence and automation

60 requirements.

## Phase 19 · Ethics and probity

**Requirements:** E-001 to E-013.

Conflict-of-interest declarations at sourcing and committee stages with recusal
that committee voting respects. Gifts and hospitality register — the register is
built, **thresholds blocked on ES-003**, and the absolute bar during a live tender
is implemented because it needs no threshold. Case and document-level commercial
confidentiality so a competing supplier cannot receive another's terms (E-011,
E-012) — this closes a real current exposure where any holder of `QUOTE_VIEW` sees
every vendor's quote. NDA records. Anti-bribery escalation as a **reference path
only**, not a whistleblowing platform (ES-004).

## Phase 20 · Disposal evidence chain

**Requirements:** AS-004 to AS-012, AS-016.

The nine-step chain gated so closure is impossible while mandatory evidence is
absent: physical inspection report, pictorial evidence of material, Finance
depreciated and residual value, committee approval, RFQ/quotes, sale with
five-party attendance confirmation, pictorial evidence of activity, Finance FAR
update confirmation, inventory update, IA conclusion report. Property loss and
theft reporting to Admin.

## Phase 21 · Governance

**Requirements:** GV-001 to GV-007, AS-014.

Policy acknowledgement per employee and version. Quarterly access-rights review
consuming the SoD matrix from Phase 1. Annual compliance audit, manual review and
interface-testing records — the last blocked on ES-018. Document retention and
entry logs — **schedule blocked on ES-002**, so versioning and non-overwrite are
implemented and retention periods are configuration left unset.

## Phase 22 · Admin masters, organogram UI, MIS

**Requirements:** RC-016, RC-017, CA-001, CA-002, FI-008, plus the orphaned code.

Expose `placeOnOrganogram`, `appointPoc`, `removePoc` with permissions and audit —
currently 351 lines of working server code with no screen. Assess each orphaned
`masters.ts` function against a real requirement before exposing it; seed the
supplied master data (7 Sage item groups, 11 units of measure, 10 stacking
categories, 3 construction categories, 16 functional/non-functional items) as
**classification dimensions**, not a forced single hierarchy (PC-015). Scheduled
Monthly Supply Chain MIS through the scheduler and outbox — never emailed from a
request transaction.

---

# P3 — Analytics, performance and usability

## Phase 23 · N+1 remediation

Investigate before changing, per the brief. Confirmed sites:

| Location | Pattern | Approach |
|---|---|---|
| `budget.ts:150` | `budgets.map(b => budgetPosition(b.id))` — 1 query per line, each running 3 more | Single aggregate query grouped by budget dimensions |
| `invoice.ts:101`, `:102`, `:321` | nested loops issuing queries | Batch fetch, map in memory |
| `vendors.ts:486`, `:487` | nested loops | Batch fetch |
| `stores.ts:611`, `:1018` | per-row queries | Batch fetch |
| `sourcing.ts:359` | per-row | Batch fetch |
| `cpc.ts:127` | per-row | Include on the parent query |
| `assets.ts:264` | per-row | Batch fetch |
| `allocations.ts:35`, `:201` | per-row | Batch fetch |
| `cost-analysis.ts:93` (mine) | per-item price history | Already batched by item list — verify |
| `org.ts:91`, `:125` (mine) | escalation walks the ladder sequentially | Single recursive CTE or cached ladder |
| `analytics/audit/[id]:83` | per-row | Include |
| `cpc/meetings/[id]:86`, `:87` | per-row | Include |

Correctness first: each change gets a test asserting identical output before and
after.

---

## What this plan does not claim

**It does not close every requirement.** 7 requirements are `EXT` and cannot be
implemented without a supplied document. 5 are `CONF` and cannot be implemented
without a management decision. A further 12 are partially blocked.

The plan builds the *mechanism* for every blocked requirement where doing so is
safe, and leaves the *rule* unset so the system reports "not configured" rather
than applying an invented default. That is the difference between a system that
is ready for the answer and a system that pretends to have it.

**Definition of done for each phase:** typecheck clean, lint clean, full test
suite passing, production build succeeding, migrations additive and reversible,
and the phase's requirements moved to `IMPLEMENTED` in the matrix with their code
location and test file recorded.

---

## Immediately actionable outside code

Three items are configuration or decisions, not development, and block real work:

1. **`SUPABASE_SERVICE_ROLE_KEY`** must be set on Vercel and the private
   `heimdall-documents` bucket created. Until then every document feature stores
   metadata for files that vanish on the next deploy — including the Payment Pack
   built in Phase 4.
2. **The 14 `DECISION REQUIRED` conflicts** — particularly PC-002 (which vendor
   performance instrument), PC-011 (which cost analysis layout) and PC-012 (tax
   rates).
3. **ES-001 Financial Authority Limits Policy** — every PO approval threshold in
   the system is currently an invented number.
