# Test Coverage — Zameen Media

## What exists

Eight suites, 2,891 lines, running against a real database because the rules
under test live in the schema as much as in the code.

| Suite | Lines | Covers |
|---|---|---|
| `authorization.test.ts` | 791 | Server-side authorization, the domain-layer sweep, authority grounds, segregation of duties, entity scoping, role definitions |
| `gates.test.ts` | 383 | Workflow gates and preconditions |
| `demand.test.ts` | 372 | Inventory-first requirement logic, reservations, allocations |
| `lifecycle.test.ts` | 358 | State transitions, inventory ledger rules |
| `finance.test.ts` | 343 | Voucher chain, three-way match, receiving exceptions, budgets |
| `documents.test.ts` | 278 | Document access control, listing redaction, audit trail |
| `vendors.test.ts` | 257 | Vendor lifecycle, blacklisting |
| `rules.test.ts` | 109 | Domain invariants |

Plus `scripts/acceptance.ts` — an end-to-end run that drives a brand-new case
through the real service functions rather than fixtures, resolving actors,
vendors, stores and approvers from live data.

### The sweep guard

`authorization.test.ts` reads `src/server/*.ts` from disk, finds every exported
mutating function, and fails if any lacks an authorization check. A new unchecked
mutation fails there rather than in production. This is the one test that keeps
Phase 1 true as the code grows.

## What the last end-to-end run proved

`scripts/acceptance.ts`, after the Phase 2 transaction work:

| Stage | Result |
|---|---|
| 01 Requisition | **PASS** — draft created; submission refused without BOQ and drawings; approved through its configured chain |
| 02 Sourcing | **PASS** — RFQ to three vendors, three quotations recorded |
| 03 Comparative | **PASS** — lowest flagged; the cheapest is the non-compliant one; an above-lowest award refused without justification, then recorded, then raised as a tracked exception; re-recommending the lowest clears the justification |
| 04 Committee | **PASS** — threshold derived from configuration, **and the new CEO tier fired**: "at or above the goods threshold of PKR 500,000… also exceeds PKR 1,500,000, so the Office of the CEO must approve it" |
| 05 Purchase order | Reached; an invoice against an unissued order correctly refused |

The committee stage is worth noting: `CP-012` — CEO approval above PKR 1,500,000
— was `MISSING` in the matrix and now appears in the requirement text the engine
produces, driven by configuration rather than a literal.

**A run also exposed a real defect.** An earlier pass aborted at the purchase
order with `Transaction not found… refers to an old closed transaction`. The
cause was measured, not guessed: **~1.25 s per query to the database region from
a developer machine**, and a purchase order issues roughly forty statements once
its allocation and requisition transition are counted. The transaction exceeded
its ceiling and rolled back — correctly, but silently. Fixed by batching
`allocate`'s reads, raising the ceiling, and making an abort report its duration.

## Gaps — stated, not softened

### Not written, and owed

| Gap | Why it matters |
|---|---|
| **Transaction rollback tests** | Phase 2's central claim is that 61 chains are all-or-nothing. Nothing proves it. Forcing a failure at each write and asserting no partial state is the test that would |
| **Duplicate-post test** | `postGrn`'s idempotency guard is a conditional `updateMany`. Two concurrent posts should leave one receipt |
| **Concurrency test** | Two approvers acting on one step; two issues drawing the same stock |
| `receiving.ts` | Untested. Gate passes, deliveries, inspections |
| `assets.ts` | Untested. Tagging, disposal stages |
| `analytics.ts` | Untested |
| `org.ts`, `cost-analysis.ts` | Untested. Both added recently |

### Required end-to-end scenarios not yet covered

The brief names these. Only the first is partly covered, by the acceptance run.

| Scenario | State |
|---|---|
| Goods purchase, requirement → payment → closure | **Partial** — acceptance covers requisition to invoice refusal; voucher, payment and closure not asserted |
| Service purchase, requirement → Service PO/WO → acceptance → payment | **Not possible yet** — services are not a distinct concept until Phase 3 |
| Mixed need: genset oil plus testing service, linked documents, separate POs | **Not possible yet** — Phase 3 |
| Partial GRN: PO 100 → GRN 60 → GRN 40 → **GRN 41 must fail** | **Not covered.** The control itself is Phase 3 |
| Serialised laptop: GRN → serials → issue → return → repair → asset → disposal | **Not possible yet** — Phase 4 |
| AC contextual treatment: same item, project consumable vs office asset | **Not possible yet** — Phase 4 |
| CPC quorum failure | **Not covered.** Quorum is not yet enforced |
| CEO threshold | **Partly** — the requirement text is produced and asserted; the *block* on final PO approval is not built |
| Unauthorized workflow calls | **Covered** — 50 tests in `authorization.test.ts` |
| PO splitting detection | **Not covered.** Phase 8 |
| Vendor blacklist / blocking, Single Source, Emergency, Petty Cash, stock count variance, scrap disposal | **Not covered.** Phases 5 and 6 |

## Honest position on verification

Phases 1 and 2 were verified by `tsc --noEmit` across the repo, `prisma
validate`, scripted source audits, and the acceptance run above. **The rollback
and concurrency tests those phases specified were not written.** They are the
first item of Phase 3's test work rather than a footnote here, because Phase 2's
guarantee is unproven without them.

A note on cost: the suite takes roughly twenty minutes against this database, and
the acceptance run longer, because of the round-trip latency measured above. That
is a reason to co-locate a test database, not a reason to skip the tests.

## Definition of done, per requirement

No requirement counts as complete on a rendered page. Each of the 147 in-scope
requirements must end at one of:

- `IMPLEMENTED + TESTED`
- `CONFIGURED + TESTED`
- `NOT APPLICABLE` with a documented reason
- `BLOCKED BY EXTERNAL DEPENDENCY` with documented evidence
- `NEEDS BUSINESS DECISION` with an entry in `business-decisions.md`

Current standing: **22 implemented**, of which the authorization and transaction
work is tested and the rest is not. That is the number to move.
