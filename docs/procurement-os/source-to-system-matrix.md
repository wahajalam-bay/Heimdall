# Source-to-System Matrix — Zameen Media

**Entity in scope: Zameen Media.** Primary source `SOP-012 Policy Chnages (3).docx`,
document ID **ZAM/PUR/SOP-01**, read end to end including its annexures, forms,
tables and process-flow images. `ZD/PRO/SOP-01` is reference material for future
expansion and is **not** a source of Zameen Media requirements — its own rows are
in [Appendix A](#appendix-a--future--zd-only), classified `FUTURE / ZD ONLY`.

Source priority, as briefed:

| # | Source | Standing |
|---|---|---|
| 1 | ZAM/PUR/SOP-01 | Primary policy source |
| 2 | Approved meeting requirements | Supplements the SOP on how the process is expected to work |
| 3 | Current application | Code, schema, permissions, tests |
| 4 | ZD/PRO/SOP-01 | Comparison and future-proofing only |

## Scope correction from the previous matrix

The earlier register treated ZAM, ZD and BOTH rows as equal requirements. Of its
250 rows, **147 apply to Zameen Media** and **96 are ZD-only**. The ZD rows are
retained rather than deleted — they are the record of what that document says and
the basis for future expansion — but none of them creates work in this release.

The largest reclassification is the **`R-###` Roles & Responsibilities series: 34
of its rows came from the ZD SOP**, not from ZAM/PUR/SOP-01. ZAM/PUR/SOP-01 has
its own Roles & Responsibilities section and its own Checklist of Roles &
Responsibilities, and those need reading against this series before any of it is
treated as a Zameen Media duty. That verification is **open** and is recorded as
`BD-001` in `business-decisions.md`.

## Zameen Media coverage

| Status | Count |
|---|---|
| IMPLEMENTED | 22 |
| PARTIAL | 59 |
| MISSING | 58 |
| CONFLICT | 4 |
| NOT APPLICABLE | 4 |
| **Total in scope** | **147** |

| Priority | Count |
|---|---|
| P0 | 20 |
| P1 | 81 |
| P2 | 24 |
| P3 | 4 |
| — | 17 |

`PARTIAL` includes the five rows the previous register marked `BROK` — a control
that exists but does not hold. They are called out in the plan, not softened here.

## Fields

Each row carries the thirteen fields the brief specifies. Where a field was already
captured under a different name in the previous register it is carried across:

| Field | Column |
|---|---|
| Requirement ID | ID |
| Source document | Src (ZAM = ZAM/PUR/SOP-01, BOTH = stated in both, applied as ZAM) |
| Section / page / annexure | § |
| Exact business rule | Requirement |
| Applicable entity | Entity |
| Current implementation | Current |
| Relevant code files | Code |
| Relevant DB tables | Tables |
| Permission involved | Permission |
| Status | Status |
| Test coverage | Test |
| Required change | Required change |
| Priority | Pri |

---

## Analytics  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CP-014 | BOTH | CPC ToR 7 | Ensure minimisation of procurement costs by directing negotiation of bulk discounts while ensuring quality | Zameen Media | Savings tracked | `src/server/analytics.ts` | — | — | **PARTIAL** | none | Add analytics tests | P2 |

## Assets  ·  3 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AS-001 | ZAM | Disposal | Regional business units responsible for proper use, protection and disposal of company property in their custody | Zameen Media | Custodian and department on assets | `src/server/assets.ts` | — | — | **PARTIAL** | none | Add tests | P1 |
| AS-002 | ZAM | Disposal | Property defined as any capital or non-capital tangible item purchased, donated or acquired through trade regardless of value or condition, including real estate, equipment, furniture, materials, supplies, inventory stock or any item that may be used or sold | Zameen Media | Asset register covers equipment and furniture; real estate not modelled | `prisma/schema.prisma` | — | — | **PARTIAL** | none | Confirm scope | P3 |
| AS-016 | ZAM | Scrap Enf. 5 | **Report theft, loss or disappearance of company property immediately to Admin** | Zameen Media | Asset status `LOST` exists; **no reporting workflow** | `src/lib/domain.ts` | — | — | **PARTIAL** | none | Property loss reporting workflow to Admin | P2 |

## Assets, Disposal  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AS-003 | ZAM | Disposal | Scrap materials defined as discards or byproducts from installation, repair, remodelling or construction. Named: **Laptops & Desktops incl. peripherals · Handsets · POS Material · Giveaways · Copper wire and cable · Copper and steel pipe · Electric motors · Plumbing fixtures · Steel duct work · Electrical equipment and parts · Decorative metal fixtures · Vehicles** | Zameen Media | `disposalCategory` with a scrap view; the 12 named types not seeded | `src/app/(app)/disposal/scrap` | — | — | **PARTIAL** | none | Seed the 12 types | P2 |

## Assets, Inventory  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RC-018 | BOTH | Store Flow | Store keeping — **new items**: asset tagging · stacking, sorting and **movement across regions** | Zameen Media | Asset tagging from GRN exists. **No region concept** | `src/server/assets.ts` | — | — | **PARTIAL** | none | Region as a geography level | P2 |

## Build-Out  ·  12 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BO-001 | ZAM | Build-outs | Objective: coordination across departments for timely decisions, systematic execution, synergy, avoiding duplication | Zameen Media | **Absent entirely** | — | — | — | **MISSING** | none | Build-Out case with the 11-stage lifecycle | P1 |
| BO-002 | ZAM | Build-outs | **Management decision** — management gives go-ahead for a new project | Zameen Media | Absent | — | — | — | **MISSING** | none | Stage 1 with attestation | P1 |
| BO-004 | ZAM | Build-outs | **Requirement gathering** by Admin regarding build-out details, headcounts and special requirements from departments, specifically Sales | Zameen Media | Absent | — | — | — | **MISSING** | none | Stage 3 with per-department requirements | P1 |
| BO-005 | ZAM | Build-outs | Build-out SOP followed and complied with per defined timelines | Zameen Media | Absent | — | — | — | **MISSING** | none | Stage gating | P1 |
| BO-006 | ZAM | Build-outs | **Timelines defined at an early stage** and shared with the CFC | Zameen Media | Absent | — | — | — | **MISSING** | none | Project timeline with variance tracking | P1 |
| BO-007 | ZAM | Build-outs | **CFC called**, project details and scope presented; a sheet of predefined tasks at departmental level shared per the Checklist of Roles & Responsibilities; stakeholders provide additional requirements or feedback | Zameen Media | Absent | — | — | — | **MISSING** | none | CFC meeting with departmental task checklist | P1 |
| BO-008 | ZAM | Build-outs | Each department works on its areas per deadlines defined in the **weekly scheduled meetings** | Zameen Media | Absent | — | — | — | **MISSING** | none | Departmental tasks with deadlines | P1 |
| BO-009 | ZAM | Build-outs | Progress shared in the **CFC scheduled (Friday) meeting each week** and updated in the predefined checklist | Zameen Media | Absent | — | — | — | **MISSING** | none | Weekly meeting control via Compliance Scheduler | P1 |
| BO-010 | ZAM | Build-outs | **Lesson Learnt Report** at project end identifying loopholes and shortcomings for future improvement; **budgeted vs actual variance analysis for cost and timelines presented to management** | Zameen Media | Absent | — | — | — | **MISSING** | none | Lessons-learned stage with variance analysis | P1 |
| BO-012 | ZAM | `image23`,`image24` | Departmental responsibility checklist: **Sales** hiring forecast, initial requirements coordination · **HR** attendance machines, departmental hiring, trainings · **IT** support staff deployment, database administration, required trainings, IT equipment deployment, internet connectivity · **Procurement** RFQ to vendors, quotations, timely asset tagging, comparative statements, procurement orders · **Administration** detailed requirement gathering, timely deliveries at site, requirement gathering, scope of work, work order generation, day-wise schedule compliance, timely BOQ monitoring with actual, timely reporting of issues · **Finance** timely disbursement of funds · **Internal Audit** pre-audit of payments, compliance assurance, BOQ comparison · **Architect** layout finalisation, design preparation, BOQ finalisation, timely site visits · **Marketing** branding requirements at initial stage · **Legal** contract creation | Zameen Media | Absent | — | — | — | **MISSING** | none | Seed as the build-out task template | P1 |
| BO-014 | ZAM | Roles | Administration: **real-time monitoring of BOQ with actual**; finalising measurements per actual against the defined BOQ after project completion | Zameen Media | BOQ document type and `md_require_boq` config exist; **no BOQ vs actual tracking** | `src/lib/config.ts` | — | — | **MISSING** | `rules.test.ts` | BOQ lines with actual consumption and variance | P1 |
| BO-015 | ZAM | Roles | Administration: preparation of a **day-wise schedule with the vendor** and ensuring compliance at regular intervals | Zameen Media | Absent | — | — | — | **MISSING** | none | Vendor day-wise schedule with compliance checks | P2 |

## Build-Out, Delegation  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BO-011 | ZAM | `image21.PNG` | **Cross Functional Team roster with named proxies**: Sales Central (Shuja Ullah Sheikh / Regional Manager) · Sales North (Hassan Danish / Hassan Shah) · Sales South (Taha Mehmood / Murtaza Zaheer) · Finance (Tanzain Shafqat / Hammad Khursheed) · HR (Wajiha Khan / Khurram) · Talent Acquisition (Aamna Jaffery / —) · IT (Shahid Hassan / Mudassir) · Procurement (Mariam Saleem / Ali Mahmood) · Internal Audit (Basil Akram / Umer sukhera) · Architect (Haroon / Aasma) · Legal (Maryam Haq / Fareeha) · Logistic (Basharat Ali / —) · Administration (Irfan Aslam / Adeel Khalid) | Zameen Media | Absent | — | — | — | **MISSING** | none | Delegation engine seeded from this roster | P1 |

## Build-Out, RNC  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BO-003 | ZAM | Build-outs | **Final rental agreement** — acquisition of building, shortlisting of areas, final rental negotiations agreed by the RNC | Zameen Media | Absent | — | — | — | **MISSING** | none | Stage 2 linked to the RNC case | P1 |

## CPC  ·  11 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PR-008 | BOTH | §4.3.2 | For non-routine items of specific nature where **PO cost exceeds PKR 500,000, CPC approval is mandatory** for processing PRs | Zameen Media | `procurement.cpc_threshold_amount = 500000` | `src/lib/config.ts`, `src/server/cpc.ts` | — | — | **IMPLEMENTED** | `rules.test.ts` | Add routine/non-routine attribute | P1 |
| SO-005 | BOTH | §4.5.1 | Where CPC approval is mandatory, **approval from CPC is the "final approval"** | Zameen Media | CPC resolution drives the PR forward | `src/server/cpc.ts` | — | — | **PARTIAL** | `rules.test.ts` | CEO tier above CPC | P0 |
| CP-001 | BOTH | CPC | **Engagement limit: procurement of goods ≥ PKR 500,000.** Below that, Procurement decides independently per the defined authority matrix | Zameen Media | Threshold configured and routed | `src/lib/config.ts` | — | — | **IMPLEMENTED** | `rules.test.ts` | Threshold per transaction type | P1 |
| CP-003 | BOTH | CPC | Committee composition — 9 seats per entity with designations and types | Zameen Media | Members assigned **per case** with free-text `roleLabel`. **No standing roster, no member type, no effective dates** | `prisma/schema.prisma` CpcCaseMember | — | — | **MISSING** | `rules.test.ts` | Standing roster per entity with type and effective dates | P0 |
| CP-004 | ZAM | CPC | Meeting **every Wednesday** following the management committee meeting; CPC convenes as needed; **HOD Procurement or Admin arranges** | Zameen Media | `procurement.cpc_meeting_day = 3` globally | `src/lib/config.ts` | — | — | **PARTIAL** | `rules.test.ts` | Per-entity effective-dated | P1 |
| CP-006 | BOTH | CPC | **Quorum: at least 3 permanent committee members present in addition to the Head of the requisitioner department.** Alternatively all cases presented by the head or nominated proxy of the requisitioner department, **failing which the case is deferred to the next CPC** | Zameen Media | Phase 1 put in the authorization floor: `resolveCpcCase` requires `CPC_DECIDE` and entity access. It was **previously reachable by any signed-in user** — the server action gated on `requireUser()` alone. Quorum still counts no votes | `src/server/cpc.ts:373`, `src/app/(app)/cpc/actions.ts` | — | — | **PARTIAL** | `authorization.test.ts` | Policy-configurable quorum: permanent count, mandatory members, observers excluded, presenter/proxy required, auto-defer | P0 |
| CP-007 | BOTH | CPC | Observers do not vote and do not count toward permanent-member quorum | Zameen Media | No observer concept — **an observer would count as a voter** | `prisma/schema.prisma` | — | — | **MISSING** | none | Member type with vote eligibility | P0 |
| CP-008 | BOTH | CPC ToR 1 | Develop governance structure for procurement, recommending SOPs and KPIs to ensure fair, competitive, transparent procurement | Zameen Media | Out of system scope | — | — | — | **NOT APPLICABLE** | none | Record as a CPC agenda type if required | P3 |
| CP-009 | BOTH | CPC ToR 2 | Evaluate and review the need assessment of the desired procurement | Zameen Media | Case carries the PR and comparative | `src/server/cpc.ts` | — | — | **IMPLEMENTED** | `rules.test.ts` | — | — |
| CP-010 | BOTH | CPC ToR 3 | Selection of vendors based on quote analysis / comparative statement, **environmental impact** and technical evaluation including assessment of similar deployments, product experience and market reputation | Zameen Media | Comparative, technical compliance and vendor performance available. **Environmental impact not captured** | `src/server/sourcing.ts` | — | — | **PARTIAL** | `vendors.test.ts` | Add to comparative evaluation criteria | P2 |
| CP-011 | BOTH | CPC ToR 4 | Approval of contract/PO with the selected supplier for purchases **exceeding PKR 500,000** based on technical, financial and legal implications | Zameen Media | Implemented | `src/server/cpc.ts` | — | — | **IMPLEMENTED** | `rules.test.ts` | — | — |

## CPC, Approvals  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CP-012 | BOTH | CPC ToR 5 | **All purchases above PKR 1,500,000 approved by the Office of the CEO** | Zameen Media | **Absent. CPC is the top of the ladder** | `src/lib/approvals.ts` | — | — | **MISSING** | none | CEO approval as an auditable workflow step above CPC | P0 |

## CPC, Contracts  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CP-002 | BOTH | CPC | Mandate: any transaction including **SLA · Service Contracts · AMC · Buildouts · Onetime Purchases · Exceptional Purchases (must be approved by CEO)** | Zameen Media | No transaction-type taxonomy; no contracts | `src/server/cpc.ts` | — | — | **PARTIAL** | `rules.test.ts` | Transaction type on the case; contracts module | P1 |

## CPC, Finance  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CP-016 | BOTH | CPC | Decision mechanism: once quorum finalises a decision, **HOD Procurement or the user department shares a detailed email of the decision to committee members, copying the Office of the CEO. This approval email is attached with the standard documentation trail required to initiate any payment request through Finance** | Zameen Media | **Absent. Decision is recorded but no communication is generated or required** | `src/server/cpc.ts` | — | — | **MISSING** | none | Required Communication Engine; decision email as a Payment Pack document | P0 |

## Demand  ·  2 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PR-004 | BOTH | §4.1 | Monthly repeat-order requisitions generated by **procurement (IT equipment)** and **logistics (grocery & housekeeping)**, compiling projected requirements for the whole next month | Zameen Media | Absent | — | — | — | **MISSING** | none | Monthly repeat-order planning producing reviewable draft demand | P1 |
| PR-005 | BOTH | §4.1 | Monthly requisitions comprise general supplies: **Grocery, housekeeping, stationery and IT accessories** | Zameen Media | Absent | — | — | — | **MISSING** | none | Category-to-owner mapping as configuration | P1 |

## Demand, Receiving  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R-002 | ZAM | §3.2 | Requesting departmental POCs define specifications, quality, brand, frequency of all demands; after delivery concerned dept heads or representatives verify specifications and sign the Material Inspection form | Zameen Media | Dept POCs exist (`DepartmentPoc`, 101 appointments). Inspection exists but has no dept-head signature | `src/server/org.ts`, `src/server/receiving.ts` | — | — | **PARTIAL** | `finance.test.ts` (pocFor) | Attestation engine on inspection; POC resolution already available | P1 |

## Disposal  ·  9 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AS-004 | ZAM | Scrap 1 | **Physical inspection of scrap material — Physical Inspection Report maintained.** Owner: Admin / related department / Logistics / Internal Audit | Zameen Media | Absent | — | — | — | **MISSING** | none | Gated stage with required report | P1 |
| AS-005 | ZAM | Scrap 2 | **Snaps of scrap material — pictorial evidence of all available scrap required for record and working.** Owner: Admin | Zameen Media | **No image capture on disposal** | — | — | — | **MISSING** | none | Image attachment as a gating requirement | P1 |
| AS-006 | ZAM | Scrap 3 | **Material financial factor — Finance determines and gives feedback on depreciated value and residual value.** Owner: Finance | Zameen Media | `bookValue` and `estimatedValue` exist; no Finance feedback step | `src/server/assets.ts` | — | — | **PARTIAL** | none | Gated stage with Finance actor | P1 |
| AS-007 | ZAM | Scrap 4 | **Approval from committee/committee member.** Where value/quantum is insignificant, after consulting the relevant business head. SCM presents the complete report and seeks approval. Owner: Procurement | Zameen Media | Configurable thresholds exist but are invented | `src/lib/config.ts` | — | — | **PARTIAL** | `rules.test.ts` | Policy Pack thresholds once supplied | P1 |
| AS-008 | ZAM | Scrap 5 | **RFQ for tender / quotes — depending upon volume, quotes required and assessed.** Owner: Procurement | Zameen Media | Bids exist on disposal cases | `src/server/assets.ts` | — | — | **PARTIAL** | none | See ES-022 | P1 |
| AS-009 | ZAM | Scrap 6 | **Sale of scrap material — scrap activity done in the presence of IA, Finance, Admin, Procurement and Logistics.** Owner: all five | Zameen Media | **No attendance model** | — | — | — | **MISSING** | none | Attendance/witness confirmation via attestation engine | P1 |
| AS-010 | ZAM | Scrap 7 | **Pictorial evidence of activity — the scrap activity must include pictorial evidence for record.** Owner: Procurement / Admin | Zameen Media | Absent | — | — | — | **MISSING** | none | Image attachment as gating requirement | P1 |
| AS-011 | ZAM | Scrap 8 | **Write off / salvage value — Finance updates the FAR at their end and inventory updates its records accordingly.** Owner: Finance / Logistics | Zameen Media | Asset status moves to DISPOSED; **no FAR update confirmation** | `src/server/assets.ts` | — | — | **PARTIAL** | none | Finance FAR confirmation as a gated step | P1 |
| AS-012 | ZAM | Scrap 9 | **Conclusion report — a comprehensive report submitted by IA to the committee.** Owner: IA | Zameen Media | Absent | — | — | — | **MISSING** | none | Gated closure requiring the IA report | P1 |

## Documents  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FI-004 | BOTH | §4.7 | A copy of the document set kept in the procurement department's record | Zameen Media | Documents stored. **`SUPABASE_SERVICE_ROLE_KEY` unset — files are lost on every Vercel deploy** | `src/lib/storage.ts` | — | — | **PARTIAL** | `documents.test.ts` | Set the key and create the bucket | P0 |

## Finance  ·  7 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R-004 | ZAM | §3.4 | Procurement processes all invoices and ensures availability of supporting documents before submitting to finance **as per Annexure A** | Zameen Media | Invoice verification and 3-way match exist. **All 30 document types are `optional`** | `src/server/invoice.ts`, `DocumentType.required` | — | — | **PARTIAL** | `finance.test.ts` | Required Document Engine + Payment Pack; seed the Annexure A set per entity | P0 |
| PO-007 | BOTH | PO Disb. | **Procurement to Accounts/Payables** — invoice cross-checked against the PO; a copy of the PO attached with the requisition, invoice and GRN; complete set forwarded to Accounts | Zameen Media | 3-way match exists; document set not enforced | `src/server/invoice.ts` | — | — | **PARTIAL** | `finance.test.ts` | Payment Pack | P0 |
| FI-001 | BOTH | §4.7 | **All payments verified by Sr Manager Procurement and duly signed by Director Procurement** for processing | Zameen Media | Configurable voucher signatory ladder exists; **not set to this chain** | `src/server/vouchers.ts` | — | — | **PARTIAL** | `finance.test.ts` | Seed the SOP chain per entity | P1 |
| FI-002 | BOTH | §4.7 | After delivery, the **invoice is cross-checked against the PO** of that order | Zameen Media | 3-way match with quantity, price and absolute-value tolerances | `src/server/invoice.ts` | — | — | **IMPLEMENTED** | `finance.test.ts` | — | — |
| FI-003 | BOTH | §4.7 | A copy of the PO attached with relevant documents **per Annexure A**, then forwarded to Finance | Zameen Media | **All 30 document types optional; no pack** | `DocumentType.required` | — | — | **PARTIAL** | `documents.test.ts` | Payment Pack + Required Document Engine | P0 |
| FI-005 | ZAM | `image14.PNG` Annexure A | Payment chain: Invoice Received → **Procurement compiles set of documents** → **KPMG calculates applicable taxes** → **Audit crosschecks and reviews documents** → **Accounts books A/P** → **Finance prepares cheque** → **Audit crosschecks complete processing** → **Finance cheque signing and informs Procurement** → **Procurement informs vendor for cheque collection (Tue & Fri only)** | Zameen Media | Invoice → voucher → handoff. **No Audit checkpoints, no external tax step, no collection-day rule** | `src/server/vouchers.ts` | — | — | **PARTIAL** | `finance.test.ts` | Configurable payment route with named function checkpoints | P0 |
| FI-007 | BOTH | §4.8 | Taxes **in accordance with the Income Tax Ordinance currently applicable in Pakistan** | Zameen Media | `finance.default_tax_rate_percent = 18`; Cost Analysis Form defaults **16**. **Neither has SOP authority and they contradict each other** | `src/lib/config.ts`, `src/server/cost-analysis.ts` | — | — | **PARTIAL** | `finance.test.ts` | Effective-dated tax configuration; no silent default on a printed form | P0 |

## GRN  ·  4 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RC-012 | BOTH | §4.7 | Once formalities are complete, **Store In-charge prepares GRN / General Stock Receipt through the ERP System and updates stock** | Zameen Media | Implemented, ledger-backed | `src/server/grn.ts` | — | — | **IMPLEMENTED** | `lifecycle.test.ts` | — | P0 |
| GR-001 | — | derived from §4.7 | GRN posting must not leave partial state across GRN, inventory ledger, received quantities, price history, stacking, asset tagging and PO fulfilment | Zameen Media | **`postGrn` performs 4 direct writes plus `postMovement`, `writeAudit`, `notify`, `createTask`, `completeTasks`, `recomputePoFulfilment`, `tagAssetsFromGrn` — none in a transaction. Zero `$transaction` calls exist anywhere in 24 server modules** | `src/server/grn.ts` | — | — | **PARTIAL** | `lifecycle.test.ts` | Wrap critical writes in `$transaction`; outbox for notifications; idempotency key; rollback tests | P0 |
| GR-002 | — | derived | Duplicate GRN posting must be prevented | Zameen Media | Status guard only | `src/server/grn.ts` | — | — | **PARTIAL** | `lifecycle.test.ts` | Idempotency on post | P0 |
| GR-003 | BOTH | §4.7 derived | Over-receipt beyond allowed policy must not post without an exception | Zameen Media | Config exists | `src/lib/config.ts` | — | — | **PARTIAL** | `rules.test.ts` | Compliance case on over-receipt | P1 |

## Inspections  ·  5 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RC-004 | BOTH | §4.7 | **Technical inspection carried out by the designated technical team** per the defined form | Zameen Media | `scheduleInspection` now enforces `INSPECTION_SCHEDULE` / `INSPECTION_PERFORM` plus entity scope (Phase 1). Designated-team routing and the Annexure 4 form remain outstanding | `src/server/receiving.ts:541`, `src/lib/permissions.ts` | — | — | **PARTIAL** | `authorization.test.ts` | Inspection responsibility matrix as configurable master data; Annexure 4 form built to `image17.png` | P1 |
| RC-005 | BOTH | §4.7 | Marketing collaterals and other items requiring departmental inspection are inspected accordingly | Zameen Media | Not routed by category | `src/server/receiving.ts` | — | — | **MISSING** | none | Inspection responsibility matrix | P1 |
| RC-007 | BOTH | §4.7 | Where an inspection form is mandatory, store in-charge informs all concerned for physical inspection per **Annexure 4**; once done the form is **filled and signed by all concerns** | Zameen Media | Inspection record with a single `signedByName` text field | `src/server/receiving.ts` | — | — | **PARTIAL** | none | Annexure 4 form + attestation engine for each signatory | P1 |
| RC-008 | BOTH | `image17` | Annexure 4 Goods/Material Inspection Note fields: **Receiving Date · Inspection Date · Supplier Name** · per line Sr.No, **Item Code**, Item Description, **Inspection Type (QUANTITATIVE: QTY, PASSED, REJECTED; QUALITATIVE/TECHNICAL: PASSED, REJECTED)**, **Expiry Date** · totals **Received Quantity, Inspected Quantity, Accepted Quantity, Returned Quantity** · certification text referencing **PO #** · **reason for rejection/return** · **Logistics (Received by): Name, Designation, Sign, Date** · **Concerned Department (Signature - POC): Name, Designation, Sign, Date** | Zameen Media | Per-line pass/fail quantities exist. **The form, the certification text, the totals block, the expiry column, the item code and the two signature blocks are absent** | `src/server/receiving.ts` | — | — | **PARTIAL** | none | Build the form; wire to PO/delivery/GRN; attestation for both blocks | P1 |
| RC-009 | BOTH | Store Flow | Inspection responsibility matrix — **Technical / Qualitative / Quantitative** across Stationery, Giveaways, Furniture, Housekeeping & Grocery, IT/Network/Mobiles, Electronic Appliances, Printed Collateral; owners **Store / Admin / IT** | Zameen Media | Single `inspectionType` defaulting to `GENERAL` | `prisma/schema.prisma` | — | — | **MISSING** | none | Configurable policy table: category × inspection type → owner role | P1 |

## Inventory  ·  5 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R-003 | ZAM | §3.3 | Manager Logistics maintains stock list with specifications and minimum stock level defined from past consumption or POC advice; responsible for receipt/issuance record keeping and must present it on demand | Zameen Media | `reorderLevel` per inventory row; ledger holds receipt and issuance | `src/server/inventory.ts` | — | — | **PARTIAL** | `lifecycle.test.ts` | Demand/consumption analytics feeding a reorder suggestion | P2 |
| RC-013 | BOTH | §4.7 | **Internal auditor audits the store on a monthly basis** to monitor stock and inventory status | Zameen Media | **Absent — no stock count of any kind** | — | — | — | **MISSING** | none | Stock Count / Cycle Count module + monthly control | P1 |
| RC-014 | BOTH | §4.7 | Most goods stored in warehouse / on-site store; **stacking per Annexure 5** | Zameen Media | Bins, handling classes, stacking record per GRN | `src/server/grn.ts` | — | — | **IMPLEMENTED** | `lifecycle.test.ts` | — | — |
| RC-015 | BOTH | Annexure 5 | Stacking guidelines: designated stackable areas · layout and category-wise indicators · **FIFO** · not near wires/electrical appliances · not near doors/walkways · portable stairways for height · heavy goods at ground level · aisle use for slow-moving goods with historic-data decisions · liquids on wooden pallets · **handsets, laptops and high-value goods in strong cabinets/strong rooms with entry/exit management** · hand-jack pallets for heavy loads · care at height · in-house or packing services support · empty boxes stacked separately · distance maintained to avoid mixing · **only authorised persons in stacking areas** · new goods stacking instructions communicated to all warehouses | Zameen Media | Handling classes and bin assignment exist; FIFO/FEFO via expiry-ordered allocation | `src/server/inventory.ts` | — | — | **PARTIAL** | `lifecycle.test.ts` | Handling class rules incl. secure storage; bin access restriction | P2 |
| AS-015 | ZAM | Scrap Enf. 4 | Enforce policies on acceptable use, disposal, transfer and recording of property location, **inventory counts** and physical security measures | Zameen Media | No stock count | — | — | — | **MISSING** | none | Stock Count module | P1 |

## Inventory, Assets  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RC-019 | BOTH | Store Flow | Store keeping — **employee return**: Store Receiving Note → inspection (**IT equipment only**) → fails: sent to **Repair and Maintenance Dept** → passes: Store Manager proceeds to stacking and inventory | Zameen Media | **Absent entirely** | — | — | — | **MISSING** | none | Employee Return workflow with SRN, conditional inspection, R&M handoff, custodian clearance | P1 |

## Inventory, Masters  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RC-016 | BOTH | `image19.emf` | **Table 1.1 Main Categories for Stacking of Goods** (10): Electronics · Hardware · Grocery · Housekeeping · Stationery · Giveaways · IT Equipment · Furniture & Fixture · Branding Material · Printing Material | Zameen Media | Category tree exists but not this taxonomy | `prisma/schema.prisma` | — | — | **MISSING** | none | Add classification dimension; seed all 10 | P2 |

## Issuance, Inventory  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RC-020 | BOTH | Store Flow | Issuance: **(a) only against a PR form** · (b) **Issuance Slip signed by the receiver (user department)** · (c) Store Manager updates "Exit from Inventory" and checks balance against minimum stock level for recurring items · (d) **if minimum reached, Store Manager alerts the relevant procurement associate and a PR/PO is issued** | Zameen Media | Issue against requisition ✓; ledger exit ✓; below-reorder flag ✓. **No receiver signature, no issuance slip, no procurement-associate alert, no replenishment PR** | `src/server/stores.ts` | — | — | **PARTIAL** | `lifecycle.test.ts` | Attestation for receiver; printable slip; named-associate notification; policy-based replenishment draft | P1 |

## Masters  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RC-017 | BOTH | `image18` | **Sage 300 item groups** (7): ELT Electronics · HDW Hardware · HKG Housekeeping & Grocery · PNT Printing Material · STA Stationary & Giveaways · ACC Accessories · ITE IT Equipment. **Units of measure** (11): Bottle, Box, Bucket, Carton, KG, Length, Liter, Pack, Pcs, Rim, Roll | Zameen Media | `masters.ts` has `upsertUom` and item-code rules — **all orphaned, no UI**. Neither list seeded | `src/server/masters.ts` | — | — | **PARTIAL** | `finance.test.ts` | Seed both lists; expose master data UI | P2 |

## Petty Cash  ·  8 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PC-101 | BOTH | §4.4 | Petty cash purchases **up to PKR 15,000** may be made without regular procurement procedures | Zameen Media | `procurement.petty_cash_limit = 15000` | `src/lib/config.ts` | — | — | **IMPLEMENTED** | `rules.test.ts` | Effective-dated in Policy Pack | P1 |
| PC-102 | BOTH | §4.4 | The procurement team member dealing with petty cash is **responsible for all these purchases** | Zameen Media | `createPettyCash` enforces `PETTY_CASH_CREATE` inside the domain function. **Phase 0 recorded this as unchecked; that was wrong** — the check was already at `pettycash.ts:68`. Named-member responsibility is still not modelled | `src/server/pettycash.ts:68` | — | — | **PARTIAL** | `authorization.test.ts` | Named petty-cash custodian per entity, drawn from the organogram POC set | P2 |
| PC-103 | BOTH | §4.4.1 + `image15` | Obtain **3 quotations from open market**, in written form including social media (WhatsApp, Skype) | Zameen Media | 3-quote capture with channel | `src/server/pettycash.ts` | — | — | **IMPLEMENTED** | `finance.test.ts` | — | — |
| PC-104 | BOTH | §4.4.1 + `image15` | Prescribed petty cash form filled with all required information, handed to requisitioner for **HOD approval**, then **approved by Director Procurement** | Zameen Media | Configurable approval; the ZD Sr Mgr comparative step is unrepresented | `src/server/pettycash.ts` | — | — | **PARTIAL** | `finance.test.ts` | Per-entity route | P1 |
| PC-105 | BOTH | `image15` | Submit approved form and **collect cash from Accounts** | Zameen Media | Not modelled as a step | `src/server/pettycash.ts` | — | — | **PARTIAL** | `finance.test.ts` | Add lifecycle stage | P2 |
| PC-106 | BOTH | §4.4.1 | Once the transaction is done, **all original documents handed to finance** and a copy retained by procurement | Zameen Media | Reconciliation stage exists | `src/server/pettycash.ts` | — | — | **PARTIAL** | `finance.test.ts` | Required Document Engine on the stage | P2 |
| PC-107 | BOTH | `image15` | Requests **not** below PKR 15,000 are "Informed Ref: PO Process" — routed to the standard PO process | Zameen Media | No automatic routing | `src/server/pettycash.ts` | — | — | **PARTIAL** | `finance.test.ts` | Refuse with a link to raise a PR, or convert | P2 |
| PC-108 | — | derived | Purchased-but-not-booked items (store entry gap) must be resolved | Zameen Media | Gap detected and displayed | `src/app/(app)/petty-cash` | — | — | **PARTIAL** | `finance.test.ts` | Persistent Alert Engine with escalation | P1 |

## Procurement  ·  11 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PR-001 | BOTH | §4 | System-generated PR raised by concerned department; where unavailable, raised on the specified PR form (Annexure 1). Entertained only on submission to purchase or store department | Zameen Media | PR with all listed fields | `src/server/pr.ts` | — | — | **IMPLEMENTED** | `lifecycle.test.ts` | — | — |
| PR-002 | BOTH | §4 | Requisitioner responsible for all specifications; **otherwise the requisition is void** | Zameen Media | `requisition.require_specification` config | `src/lib/config.ts` | — | — | **IMPLEMENTED** | `rules.test.ts` | — | — |
| PR-003 | BOTH | Annexure 1 | PR form fields: Document Date · Required Date · Document No · Department · Description/Comments · **Req Location** · Required By · **Approved By** · **Approval Status** · then per line Sr.No · **Item Code** · Description · Additional Comments · Qty · UOM · **Unit Cost** · **Total Cost** · **In Stock** · then **Document Comments** · HOD/Regional Head **Sign** · **Date** · **Stamp** · **Time** — "Stamps, Date, Time are compulsory to ensure compliance" | Zameen Media | Has description, brand, model, make, spec, qty, unit, estimated unit price, required date. **Missing: Item Code column, In Stock, Req Location, Approved By/Approval Status block, Document Comments, and the compulsory Sign/Stamp/Date/Time block** | `prisma/schema.prisma` PurchaseRequisitionItem | — | — | **PARTIAL** | `lifecycle.test.ts` | Add fields, wire to lifecycle, printable form, attestation for sign/stamp/date/time | P0 |
| PR-006 | BOTH | §4.2 | On-demand purchase requisitions generated by the concerned department with all documentary verifications and approvals | Zameen Media | Implemented | `src/server/pr.ts` | — | — | **IMPLEMENTED** | `lifecycle.test.ts` | — | — |
| PR-007 | BOTH | §4.3.1 | For routine on-demand items, **approval of the concerned departmental head** is required to process the PR | Zameen Media | `approval.department_approval_required` + DEPARTMENT_HEAD approver type | `src/lib/approvals.ts` | — | — | **IMPLEMENTED** | `rules.test.ts` | — | — |
| PO-001 | BOTH | §4.6 | **Procurement solely authorised** to issue purchase order, contract, agreement or related documents | Zameen Media | `PO_ISSUE` permission | `src/lib/permissions.ts` | — | — | **IMPLEMENTED** | `authorization.test.ts` | — | — |
| PO-002 | BOTH | §4.6 | PO mentions all necessary details: payment term, delivery location etc. | Zameen Media | Payment terms, delivery store, delivery date present | `src/server/po.ts` | — | — | **IMPLEMENTED** | `lifecycle.test.ts` | — | — |
| PO-003 | BOTH | §4.6 | PO carries **the signature of Manager Procurement or other authorised signatory** | Zameen Media | Value-band approval only. **No signatory recorded on the document** | `src/server/po.ts` | — | — | **MISSING** | `lifecycle.test.ts` | Authorised signatory via attestation engine | P1 |
| PO-005 | BOTH | PO Disb. | **Procurement to Vendor** — PO generated against the specific requisition before placing an order, by the respective buyer, after requisition receipt, vendor identification, RFQ, cost analysis and approvals | Zameen Media | Implemented; PR↔PO allocations exist | `src/server/po.ts`, `src/server/allocations.ts` | — | — | **IMPLEMENTED** | `lifecycle.test.ts` | — | — |
| PO-006 | BOTH | PO Disb. | **Procurement to Logistics** — Logistics informed through a copy of the PO regarding shipment in the pipeline, to align receipt and storage | Zameen Media | No distribution tracking | `src/server/po.ts` | — | — | **MISSING** | `lifecycle.test.ts` | PO distribution with evidence | P2 |
| PO-008 | BOTH | PO Disb. | **A copy of the PO kept for record by Procurement, Logistics and Accounts** | Zameen Media | Single record, no distribution copies | `src/server/po.ts` | — | — | **PARTIAL** | `lifecycle.test.ts` | PO distribution record | P2 |

## RNC  ·  8 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RN-001 | ZAM | RNC | Mandate: any transaction **including build-outs** | Zameen Media | **Absent entirely** | — | — | — | **MISSING** | none | RNC module, entity-scoped | P1 |
| RN-002 | ZAM | `image22.PNG` | Composition **by region**. Central: Sheikh Shuja ullah Khan (Sr. Director Sales, **Permanent Mandatory**), Mariam Saleem (Director Procurement, **Permanent Mandatory**), Irfan Aslam (Sr. Manager Admin, **Permanent Mandatory**), Adil Kamal (Head of Acquisition, Permanent), Haseeb Malik (Director Marketing, Permanent), Shahid Hassan (Director IT, Permanent), Tanzain Shafqat (Head of Finance, Permanent), Basil Akram (AM Internal Audit, **Observer**). North: Ahmad Bhatti (Country Head, Permanent), Hassan Danish (Senior Director, Permanent Mandatory), Syed Hassan Ali Shah (Sr Manager Admin, Permanent Mandatory). South: Ahmad Bhatti (Country Head, Permanent), Taha Mahmood (Senior Director, Permanent Mandatory), Murtaza Zaheer (Sr Manager Admin, Permanent Mandatory) | Zameen Media | Absent | — | — | — | **MISSING** | none | Regional committee roster with 3 member types | P1 |
| RN-003 | ZAM | RNC | RNC convenes as needed; **HOD Sales or Admin arranges** | Zameen Media | Absent | — | — | — | **MISSING** | none | Meeting scheduling | P1 |
| RN-004 | ZAM | RNC | **Quorum: at least 3 permanent members for central region present in addition to the Head of the Committee.** Alternatively presented by head or nominated proxy, failing which deferred to next RNC | Zameen Media | Absent | — | — | — | **MISSING** | none | Per-region quorum rules; flag North/South for decision | P1 |
| RN-005 | ZAM | RNC ToR | Develop governance structure for rental agreements, recommending SOPs and KPIs for fair, competitive, transparent agreements | Zameen Media | Absent | — | — | — | **NOT APPLICABLE** | none | — | — |
| RN-006 | ZAM | RNC ToR | Evaluate and review the need assessment of the desired location | Zameen Media | Absent | — | — | — | **MISSING** | none | RNC case with need assessment | P1 |
| RN-007 | ZAM | RNC ToR | **Selection of the landlord** based on quote analysis / comparative statement, environmental impact and technical evaluation | Zameen Media | Absent | — | — | — | **MISSING** | none | Landlord comparative | P1 |
| RN-008 | ZAM | RNC ToR | Ensure agreed commercial terms are in line with general market practices | Zameen Media | Absent | — | — | — | **MISSING** | none | Market evidence on the case | P1 |

## RNC, Contracts  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RN-009 | ZAM | RNC ToR | Roles and responsibilities on the landlord side clearly discussed, agreed and made part of the agreement | Zameen Media | Absent | — | — | — | **MISSING** | none | Rental agreement linkage | P1 |

## RNC, Finance  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RN-010 | ZAM | RNC | Decision mechanism: **HOD Sales or Admin shares a detailed email of the decision to members copying the CEO's office; attached with the documentation trail required to initiate payment through Finance** | Zameen Media | Absent | — | — | — | **MISSING** | none | Required Communication Engine | P1 |

## Receiving  ·  6 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RC-001 | BOTH | §4.7 | At arrival, **admin floor manager / security in-charge** checks supplier documents and materials, issues the **inward gate serial number**, and refers the vendor to the store office | Zameen Media | Gate pass, serial and store routing all present; `createGatePass` enforces `GATE_PASS_CREATE`. **Phase 0 recorded this as unchecked; that was wrong** — the check was already at `receiving.ts:41`. Supplier-document checking at the gate is not modelled | `src/server/receiving.ts:41` | — | — | **PARTIAL** | `authorization.test.ts` | Required-document check at the gate, against the Annexure A / ZD set | P1 |
| RC-002 | BOTH | §4.7 | Receiver verifies: quantity/weight · specifications against PR · physical condition (intact/damaged/leaked) · compliance with handling instructions · expiry dates where applicable · goods serial numbers matching packing details · warranty details (IT equipment and handsets verified by **IT department**) | Zameen Media | Delivery items carry quantity, discrepancy type, condition. Expiry and serial exist on inventory | `src/server/receiving.ts` | — | — | **PARTIAL** | none | Structured receipt checklist; route warranty verification per the inspection matrix | P1 |
| RC-003 | BOTH | §4.7 | For bulk receipts, packing method verified and **each box checked** against delivery documents | Zameen Media | Not modelled | — | — | — | **MISSING** | none | Package count verification on delivery | P2 |
| RC-006 | BOTH | §4.7 | On discrepancy or non-conformance found in the presence of the issuer, the receiver raises the concern with **warehouse senior management** | Zameen Media | Variance recording exists | `src/server/receiving-exceptions.ts` | — | — | **PARTIAL** | `finance.test.ts` | Persistent Alert with escalation chain | P2 |
| RC-010 | BOTH | Store Flow | If goods pass inspection, Store Manager proceeds to Goods Received. **If inspection fails, a Return-to-Vendor (RTV) document is lodged by the relevant inspector within the ERP** | Zameen Media | Vendor returns exist as a module but **are not raised from a failed inspection** | `src/server/receiving-exceptions.ts` | — | — | **PARTIAL** | `finance.test.ts` | Create/link RTV from failed inspection without re-entry | P1 |
| RC-011 | BOTH | Store Flow | Goods receiving process: 1) Intimation by Procurement 2) Inward gate pass 3) Delivery 4) Receiving count / undertaking 5) Inspection 6) GRN | Zameen Media | Gate pass → delivery → inspection → GRN implemented. **Step 1 intimation and step 4 undertaking absent** | `src/server/receiving.ts` | — | — | **PARTIAL** | none | PO distribution to Logistics covers step 1; undertaking as a document | P2 |

## Sourcing  ·  14 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SO-001 | BOTH | §4.5.1 | On receipt of PR, procurement floats RFQ to already approved vendors **or floats a Tender document via print media**; at least 3 comparative quotations finalised for negotiation | Zameen Media | Vendor-RFQ route only | `src/server/sourcing.ts` | — | — | **PARTIAL** | `vendors.test.ts` | Sourcing method enum incl. OPEN_TENDER, PRINT_MEDIA_TENDER; evidence only, no provider integration | P1 |
| SO-002 | BOTH | §4.5.1 | A price negotiating **call or meeting** conducted by procurement with the vendors | Zameen Media | Negotiation rounds recorded | `src/server/sourcing.ts` | — | — | **IMPLEMENTED** | `vendors.test.ts` | — | — |
| SO-003 | BOTH | §4.5.1 | Negotiation based on financial evaluation/competitive price, payment terms, product/service quality, on-time delivery, after-sales services, warranties | Zameen Media | All six dimensions captured on quotes | `src/server/sourcing.ts` | — | — | **IMPLEMENTED** | `vendors.test.ts` | — | — |
| SO-004 | BOTH | §4.5.1 | **Preparation of Comparative Statement, Negotiation Minutes, approval documents and conclusion is to be documented** | Zameen Media | CST exists. **Negotiation Minutes as a distinct signed document does not** | `src/server/sourcing.ts` | — | — | **PARTIAL** | `vendors.test.ts` | Negotiation Minutes record with participants, before/after terms, prepared/verified by, signatures, attachments | P1 |
| SO-006 | BOTH | §4.5.1 | Price comparison and negotiation recorded **via Annexure 3** | Zameen Media | Built from xlsx layout | `src/server/cost-analysis.ts` | — | — | **PARTIAL** | none | Versioned form; seed Annexure 3 | P0 |
| SO-007 | BOTH | `image16` | Annexure 3 fields: PR No · Date · per line Description, **Last PO No**, Last PO Date, Last Purchase Price · per vendor (**Option A/B/C**) Rate, Qty/Unit, Total · Terms rows: Delivery Time Period, Payment Terms, **Quotation Validity**, GST/Tax, **After Sale Services/Warranties**, **Other Pertinent Details** · Note · PO Awarded To · Invoice Charged To · Approved By · Remarks/Conclusion · Special Notes (4 questions) · **2 Name/Signature blocks** | Zameen Media | 5 vendors, subtotal/tax/net rows, 4 terms rows, free-text higher-rate reason, 2 signatures present | `src/app/(app)/comparatives/[id]/cost-analysis` | — | — | **PARTIAL** | none | Align to Annexure 3 as a version | P0 |
| SO-008 | BOTH | `image16` | Special Notes: Is vendor Single Sourced? · Are rates already locked with the Vendor? · Is Vendor Selection form duly fulfilled and approved? · **If higher rates are approved then reason please? — Quality / Technical Special / Others** | Zameen Media | Three yes/no questions implemented; **higher-rate reason is free text, not the bounded choice** | `src/server/cost-analysis.ts` | — | — | **PARTIAL** | none | Convert to bounded choice | P1 |
| SO-009 | BOTH | Price Comp. | Last buying price reviewed | Zameen Media | Derived from `priceHistory` on the Cost Analysis Form | `src/server/cost-analysis.ts` | — | — | **IMPLEMENTED** | none | Add tests | P1 |
| SO-010 | BOTH | Price Comp. | For imported items, **international and local market prices analysed through authorised suppliers/distributors** | Zameen Media | Absent | — | — | — | **MISSING** | none | Import flag + international price evidence | P2 |
| SO-011 | BOTH | Price Comp. | **Single sourcing** options evaluated based on volumes | Zameen Media | Absent | — | — | — | **MISSING** | none | Single Source workflow | P1 |
| SO-012 | BOTH | Price Comp. | **Multiple sourcing** options evaluated based on volumes | Zameen Media | Not modelled as a decision | — | — | — | **MISSING** | none | Record sourcing strategy on the RFQ | P2 |
| SO-013 | BOTH | Price Comp. | Minimum of **3 quotations from approved vendors** | Zameen Media | Enforced | `src/lib/config.ts` | — | — | **IMPLEMENTED** | `rules.test.ts` | — | — |
| SO-014 | BOTH | Price Comp. | **Cost Analysis Summary** produced | Zameen Media | Implemented | `src/server/cost-analysis.ts` | — | — | **IMPLEMENTED** | none | Add tests | P1 |
| SO-016 | BOTH | Price Comp. | **For emergency purchases price competitiveness may not be considered in detail** | Zameen Media | Absent | — | — | — | **MISSING** | none | Emergency procurement workflow; authority pending | P1 |

## Vendors  ·  19 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| V-018 | ZAM | §5.1 | Vendors invited to submit company profiles; profiles reviewed and evaluated on market reputation/experience/references, credit facilities, price | Zameen Media | Profile document type and PQ criteria exist | `src/server/vendors.ts` | — | — | **IMPLEMENTED** | `vendors.test.ts` | — | — |
| V-019 | ZAM | §5.2 + `image20` | Vendor Selection Form: Prepared By, Designation, Date, Vendor Referred By; Vendor Information incl. company name/address/city/contact/type of business/representative/vendor type **and "Any other company owned by same owner"**; **Min. Qualifying Score 30/60**; sections Tax status (10), Company History (10), Key Client Reference Check (12), Payment Mode (10), Company Registration (5), Company Setup (10), Internal Reference (4); Mandatory documents **FBR Online Status, Company Registration, Job Completion Certificate from Clients**; signatures **Prepared By / Verified By / Approved By** | Zameen Media | 20 unweighted criteria (weight 1, max 3). **Section structure, related-party question, mandatory documents and 3-signature block all absent** | `src/server/vendors.ts`, `evaluation_criteria` | — | — | **PARTIAL** | `vendors.test.ts` | Rebuild PQ instrument from the form's sections; add related-party check, mandatory docs, 3 attestations | P0 |
| V-020 | BOTH | §5.2.1 | Tax status: Tax Filer **5 pts** · Sales Tax number **3 pts** · SRO/Exemptions (import vendors only, certificate required) **2 pts** | Zameen Media | `taxStatus` exists; scoring not per this scheme | `src/server/vendors.ts` | — | — | **PARTIAL** | `vendors.test.ts` | Seed as PQ criteria with these points | P1 |
| V-021 | BOTH | §5.3 + `image1` | Years in business: 1–2 yrs = 1 · 2–4 = 2 · 4–7 = 3 · 7+ = 4 | Zameen Media | Not modelled | — | — | — | **MISSING** | none | Seed criterion with bands | P1 |
| V-022 | BOTH | §5.3 + `image2` | Key client reference check: **Poor = 0 · Satisfactory or Above = 1** per client; one point per verified satisfied client; form allows **3 clients × 4 dimensions** (On Time Delivery, Quality, After Sales, Refund/Replacement), section max 12 | Zameen Media | Not modelled | — | — | — | **MISSING** | none | Reference records with 4 dimensions × 3 clients | P1 |
| V-023 | BOTH | §5.4 + `image3`,`image4` | Payment mode: Cheque/PO/Bank Draft **4** · Credit Card/Online **1**; credit line 1–14 days **2** · 15+ days **3**. Form lists Credit 1–14 / 15–20 / 21–30, Adv Cash, COD | Zameen Media | Not modelled | — | — | — | **MISSING** | none | Seed criterion; note form and image band mismatch | P1 |
| V-024 | BOTH | §5.5 + `image5` | Registration status: Corporation/Govt Body **5** · AOP **3** · Sole Proprietorship **2** · Private Limited **5** · Public Limited **5** | Zameen Media | Not modelled | — | — | — | **MISSING** | none | Seed criterion | P1 |
| V-025 | BOTH | §5.6 + `image6`,`image7`,`image8`,`image9` | Company setup: offices 1–2 = 1, 3–5 = 2 · nationwide 1 metro = 1, 2 = 2, 3 = 3 · workforce 3–10 = 1, 11+ = 2 · capability: ability to fulfil order = 2, transportation system = 1. Form adds **Delivery On Site (FOC Basis) — Lahore only** | Zameen Media | Not modelled | — | — | — | **MISSING** | none | Seed criteria | P1 |
| V-026 | BOTH | §5.7 | Terms: market-competitive pricing (lower or equal) **4 pts** else 0 · availability of after-sales support staff **2 pts** · refunds for or replacement of rejected items **4 pts** | Zameen Media | Not modelled as PQ criteria | — | — | — | **MISSING** | none | Seed criteria | P1 |
| V-027 | BOTH | §5.8 + `image10` | Internal reference: points by referrer designation. **Image: Manager 3 / Sr Manager 4 / Director+ 5. Form: Manager 1 / Sr Manager 2 / Director+ 4** | Zameen Media | Not modelled | — | — | — | **CONFLICT** | none | Versioned criterion; both variants seeded | P1 |
| V-028 | BOTH | §5.9 + `image11` | Vendor performance evaluation instrument — weighted, qualifying score **50/100** | Zameen Media | Wrong instrument | `evaluation_criteria` | — | — | **CONFLICT** | `vendors.test.ts` | Versioned instruments, both seeded, admin selects | P0 |
| V-029 | BOTH | §5.9 | Performance rating scale | Zameen Media | Absent | — | — | — | **CONFLICT** | none | Versioned rating scale | P1 |
| V-030 | BOTH | §5.10 | Delivery lead time: required delivery date on the PO cross-checked against actual delivery date. All before time = 5 · all on time = 4 · 80% = 3 · 50% = 2 · 30% = 1 · <30% = 0 | Zameen Media | `onTimePercent` computed | `src/server/vendors.ts` | — | — | **PARTIAL** | `vendors.test.ts` | Map computed % to source bands | P1 |
| V-031 | BOTH | §5.11 | Competitiveness of price: 10% below market = 5 · 5% below = 4 · same = 3 · 5% above = 2 · 10% above = 1 · >10% above = 0 | Zameen Media | Price variance computed on comparatives, not as a vendor score | `src/server/analytics.ts` | — | — | **PARTIAL** | none | Score band + recurring Price Competitiveness control | P1 |
| V-032 | BOTH | §5.12 + `image12` | Quality: inspection form determines supplier performance. **Text: by complaint count (0–1=40 … 7–10=0). Image: by accepted quantity % (≥95=5 … <50=1)** | Zameen Media | `qualityPercent` exists | `src/server/vendors.ts` | — | — | **CONFLICT** | `vendors.test.ts` | Versioned scoring method | P1 |
| V-033 | BOTH | §5.13 + `image13` | Technical support staff expertise: Unsatisfactory 1 · Development Needed 2 · Satisfactory 3 · Above Expectations 4 · Exceptional 5 | Zameen Media | Absent | — | — | — | **MISSING** | none | Seed as criterion in the 5-criteria variant | P1 |
| V-034 | BOTH | §5.14 | After sales services: warranty claims, complaint handling/response, refunds; evaluated on speed and effectiveness of query resolution | Zameen Media | Not scored | — | — | — | **MISSING** | none | Seed criterion | P1 |
| V-035 | ZAM | §5.14 | Blacklisting grounds: forged documents · consistent quality compromise · variance in price on invoice and quantity · consistent partial or late deliveries · other reasons | Zameen Media | Grounds not seeded | `src/server/vendors.ts` | — | — | **PARTIAL** | `vendors.test.ts` | Seed per entity | P2 |
| SO-015 | BOTH | Price Comp. | New vendor inductions completing all pertinent prerequisites | Zameen Media | PQ exists; not gated | `src/server/vendors.ts` | — | — | **PARTIAL** | `vendors.test.ts` | Sourcing gate on PQ | P1 |

## Vendors, Admin  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R-001 | ZAM | §3.1 | Director/Sr Manager Procurement arranges resources, selection, pre-qualification, registration of new suppliers; monitors performance and evaluation of existing approved suppliers; ensures all activity follows the process | Zameen Media | Roles `PROCUREMENT_DIRECTOR`, `PROCUREMENT_SENIOR_MANAGER` exist with permission sets | `src/lib/permissions.ts` | — | — | **PARTIAL** | `authorization.test.ts` | Assign the vendor-performance and PQ controls to this role via Compliance Scheduler so the duty produces evidence | P2 |

## Vendors, CPC  ·  1 requirement

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CP-013 | BOTH | CPC ToR 6 | Mechanism to evaluate suppliers per management objectives and review supplier evaluation results so only fully qualified suppliers are retained | Zameen Media | Evaluations exist; no CPC review of results | `src/server/vendors.ts` | — | — | **PARTIAL** | `vendors.test.ts` | CPC agenda item fed by evaluation control | P2 |

## Work Orders  ·  2 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PO-004 | BOTH | §4.6 | **Work order issued by the Admin department on the basis of rates negotiated by Procurement** | Zameen Media | **Absent — no work order document type** | — | — | — | **MISSING** | none | First-class Work Order workflow | P1 |
| CP-015 | BOTH | CPC | **Services acquisition for Admin** not under CPC falls to Admin; **before raising any work order it must be reviewed and approved by Internal Audit** | Zameen Media | **Work orders absent; IA approval absent** | — | — | — | **MISSING** | none | Work Order workflow with IA approval gate | P1 |

## —  ·  3 requirements

| ID | Src | § | Requirement | Entity | Current | Code | Tables | Permission | Status | Test | Required change | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BO-013 | ZAM | Roles | Administration: **creation of a WhatsApp group** for timely coordination of updates and meeting invites | Zameen Media | Absent | — | — | — | **NOT APPLICABLE** | none | Record as an off-system task in the checklist | P3 |
| AS-013 | ZAM | Scrap | **Failure to follow this policy may result in disciplinary action up to and including termination** | Zameen Media | Out of system scope | — | — | — | **NOT APPLICABLE** | none | — | P3 |
| AS-014 | ZAM | Scrap Enf. 1–3 | Business unit managers: review the policy with employees and maintain documentation of the review · incorporate the policy into new-employee orientation · periodically review disposal procedures and practices | Zameen Media | Governance | Absent | — | — | **MISSING** | — | No policy-review evidence | — |

> **Tables** and **Permission** are shown as `—` where the previous register did not
> record them per row. They are filled in as each phase touches the requirement,
> rather than guessed now: a wrong table name in a traceability document is worse
> than an admitted blank.

---

## Appendix A — FUTURE / ZD ONLY

96 requirements read from `ZD/PRO/SOP-01` with no counterpart in
ZAM/PUR/SOP-01 and none in the approved meeting requirements. **None is
implemented in this release.** They are listed so the reading is not lost and so a
future Zameen Development phase starts from evidence rather than a re-read.

| Series | Rows | What it covers |
|---|---|---|
| R-### | 34 | Roles & responsibilities (ZD wording) — **see BD-001** |
| V-### | 17 | Vendor governance: PQ validity, blocking, visit reports, master-data change |
| E-### | 13 | Ethics and probity clauses |
| GV-### | 9 | Governance controls: reviews, reconciliations, interface testing |
| S-### | 8 | Sourcing and planning clauses |
| PR-### | 7 | Requisition clauses |
| PO-### | 2 | Purchase order clauses |
| FI-### | 2 | Finance and payment clauses |
| CA-### | 2 | Cost analysis clauses |
| SO-### | 1 | Sourcing clause |
| CP-### | 1 | Committee clause |

<details>
<summary>Full ZD-only list</summary>

| ID | § | Requirement | Why out of scope |
|---|---|---|---|
| R-005 | §3 HoSC | Head of Supply Chain: ensure completeness/accuracy/integrity of Master Data | Stated only in ZD/PRO/SOP-01 |
| R-006 | §3 HoSC | Review and approve Purchase Orders per Financial Authority Limits Policy | Stated only in ZD/PRO/SOP-01 |
| R-007 | §3 HoSC | Review and approve Pre-Qualification Form for vendors **exempted** from the PQ process | Stated only in ZD/PRO/SOP-01 |
| R-008 | §3 HoSC | Review master data entered in VM sheet; review and approve master data change request | Stated only in ZD/PRO/SOP-01 |
| R-009 | §3 HoSC | Review and approve comparative statement for **rate running contracts** | Stated only in ZD/PRO/SOP-01 |
| R-010 | §3 HoSC | Review and approve the Agreement with vendor | Stated only in ZD/PRO/SOP-01 |
| R-011 | §3 SrMgr | Review vendor documents obtained for pre-qualification; evaluate against approved PQ criteria | Stated only in ZD/PRO/SOP-01 |
| R-012 | §3 SrMgr | Review Vendor Master Data **annually** for completeness, integrity, accuracy | Stated only in ZD/PRO/SOP-01 |
| R-013 | §3 SrMgr | Inform vendor of the criteria against which performance will be evaluated | Stated only in ZD/PRO/SOP-01 |
| R-014 | §3 SrMgr | Review and sign off the Vendor Performance Evaluation Form | Stated only in ZD/PRO/SOP-01 |
| R-015 | §3 SrMgr | Ensure all Open POs (partially or completely open) no longer required are **closed monthly** | Stated only in ZD/PRO/SOP-01 |
| R-016 | §3 SrMgr | Maintain record of all procurement information/data/documentation as referred in Supply Chain Manual | Stated only in ZD/PRO/SOP-01 |
| R-017 | §3 SrMgr | Generate Master Data Maintenance Report and share with Head of Supply Chain and Business Process Owner | Stated only in ZD/PRO/SOP-01 |
| R-018 | §3 SrMgr | Review and approve **manual** comparative statement for petty cash procurement | Stated only in ZD/PRO/SOP-01 |
| R-019 | §3 BuySpec | Negotiate terms and conditions with material/service provider | Stated only in ZD/PRO/SOP-01 |
| R-020 | §3 BuySpec | Request vendor to provide information on Vendor PQ Form with all documentation | Stated only in ZD/PRO/SOP-01 |
| R-021 | §3 BuySpec | Conduct visit of vendor premises where required; report findings on **Vendor Visit Report** / email record | Stated only in ZD/PRO/SOP-01 |
| R-022 | §3 BuySpec | Enter particulars of prequalified vendor and attach all documentation in VM | Stated only in ZD/PRO/SOP-01 |
| R-023 | §3 BuySpec | Raise Master Data Change Request in VM to Finance and update respective master data fields | Stated only in ZD/PRO/SOP-01 |
| R-024 | §3 BuySpec | Share **Performance Gaps Report** with vendor on unsatisfactory/unacceptable rating | Stated only in ZD/PRO/SOP-01 |
| R-025 | §3 BuySpec | Conduct vendor evaluation and record findings via Performance Evaluation Form | Stated only in ZD/PRO/SOP-01 |
| R-026 | §3 BuySpec | Inform vendor of blocking/blacklisting decision with reasoning and the condition for unblocking/relisting | Stated only in ZD/PRO/SOP-01 |
| R-027 | §3 BuySpec | Review PR for completeness/accuracy; **revert within 24 working hours** to Planning with reasoning if discrepant | Stated only in ZD/PRO/SOP-01 |
| R-028 | §3 BuySpec | **Generate RFQ within 24 working hours** of receipt of PR | Stated only in ZD/PRO/SOP-01 |
| R-029 | §3 BuySpec | Float RFQ with technical specifications and project information to prequalified vendors **via email keeping Sr Manager SC and Head of SC in copy** | Stated only in ZD/PRO/SOP-01 |
| R-030 | §3 BuySpec | Receive quotations and perform commercial **and technical** evaluation | Stated only in ZD/PRO/SOP-01 |
| R-031 | §3 BuySpec | Prepare manual comparative statement as per Annexure 3 | Stated only in ZD/PRO/SOP-01 |
| R-032 | §3 BuySpec | State reasoning in the comparative where fewer than three PQ quotations are received **or** the cheapest vendor is not selected | Stated only in ZD/PRO/SOP-01 |
| R-033 | §3 BuySpec | Initiate contract negotiation and agree terms of vendor agreement | Stated only in ZD/PRO/SOP-01 |
| R-034 | §3 BuySpec | Generate Purchase Order **in Sage** for selected vendor | Stated only in ZD/PRO/SOP-01 |
| R-035 | §3 BuySpec | Approved legal terms must be shared with the PO including payment terms and delivery date | Stated only in ZD/PRO/SOP-01 |
| R-036 | §3 BuySpec | Obtain **written acknowledgement** from vendor against PO; if not received, execution of PO scope is deemed acceptance | Stated only in ZD/PRO/SOP-01 |
| R-037 | §3 BuySpec | Monitor vendor per SOP and report violation/non-conformity to Sr Manager Procurement | Stated only in ZD/PRO/SOP-01 |
| R-038 | §3 BuySpec | Submit vendor invoice with all supporting documents: **PR, MD, PO, GRN, MIR, CPC approval** | Stated only in ZD/PRO/SOP-01 |
| E-001 | §2.1.1 i–ii | Employees shall avoid conflict between own and company interests when dealing with suppliers; must avoid situations leading to real or perceived conflicts | Stated only in ZD/PRO/SOP-01 |
| E-002 | §2.1.1 iii | Staff **must declare** any business or personal relationship with family, relatives or friends employed by vendors quoting for contracts | Stated only in ZD/PRO/SOP-01 |
| E-003 | §2.1.2 i–ii | Employees shall not engage in, attempt, assist, encourage or ignore bribery, corruption or fraud | Stated only in ZD/PRO/SOP-01 |
| E-004 | §2.1.2 iii | Employees shall raise suspicion of bribery/corruption/fraud per the Whistle Blowing Policy | Stated only in ZD/PRO/SOP-01 |
| E-005 | §2.1.3 i–ii | Staff involved in or perceived to influence procurement may not solicit or accept gifts/hospitality/entertainment from vendors unless within the Code of Conduct; **at no time** from suppliers currently tendering or negotiating | Stated only in ZD/PRO/SOP-01 |
| E-006 | §2.1.3 iii | Any offer or supply of gifts **regardless of value** should be reported per the Code of Conduct | Stated only in ZD/PRO/SOP-01 |
| E-007 | §2.1.4 i | Source-to-pay process is deliberately spread across stakeholders to maintain integrity | Stated only in ZD/PRO/SOP-01 |
| E-008 | §2.1.4 ii | Employees should not hold conflicting roles that leave them open to accusations of unethical behaviour | Stated only in ZD/PRO/SOP-01 |
| E-009 | §2.1.5 i | Management override of controls is strictly prohibited and amounts to **mis-procurement**, e.g. **splitting POs to avoid approval thresholds** | Stated only in ZD/PRO/SOP-01 |
| E-010 | §2.1.5 ii | Where splitting POs is a genuine business need, **manual approval of the bypassed authority** must be obtained and attached to the POs | Stated only in ZD/PRO/SOP-01 |
| E-011 | §2.1.6 i–ii | Strict confidentiality on vendor sourcing, contract negotiation and supplier management. All commercial data must be treated as strictly confidential and not disclosed beyond the relevant Supply Chain team and appropriate stakeholders. **NDAs must be used** when sharing confidential information before an agreement is in place | Stated only in ZD/PRO/SOP-01 |
| E-012 | §2.1.6 iii–iv | Under no circumstances must one supplier's data be provided to another; contract terms must not be shared with competitors | Stated only in ZD/PRO/SOP-01 |
| E-013 | §2.1.7 | All staff must strictly comply with the Code of Conduct while performing duties under this manual | Stated only in ZD/PRO/SOP-01 |
| S-001 | §2.2.1 1 i | Act as one organisation rather than separate divisions when dealing with vendors; **maximise leverage by bundling all internal requirements** before going to market | Stated only in ZD/PRO/SOP-01 |
| S-002 | §2.2.1 1 ii | Procurement through transactions with financially sound and reputable organisations capable of satisfying corporate needs | Stated only in ZD/PRO/SOP-01 |
| S-003 | §2.2.1 1 iii | Material procured at most economical cost with timely delivery without compromising quality, reliability and controls | Stated only in ZD/PRO/SOP-01 |
| S-004 | §2.2.1 1 iv | Business awarded, to the greatest extent possible, on the basis of **competition among qualified suppliers** | Stated only in ZD/PRO/SOP-01 |
| S-005 | §2.2.1 2 i | Bidding and Proposal Department finalises material rates for bids/proposals in consultation with Supply Chain | Stated only in ZD/PRO/SOP-01 |
| S-006 | §2.2.1 2 ii | Once a project is awarded, Planning prepares the procurement budget **(Rev-00)** which on approval is shared with Supply Chain | Stated only in ZD/PRO/SOP-01 |
| S-007 | §2.2.1 2 iii | **Material Resource Plan** for the whole project life prepared within **3–4 weeks** of Budget Rev-00 approval; thereafter updated and shared **quarterly** | Stated only in ZD/PRO/SOP-01 |
| S-008 | §2.2.1 2 iv | Supply Chain performance evaluated against budget targets set in project budgets | Stated only in ZD/PRO/SOP-01 |
| V-001 | §2.3.1 i | No business transacted with any vendor unless it meets Vendor PQ Criteria (Annexure 6) | Stated only in ZD/PRO/SOP-01 |
| V-002 | §2.3.1 ii | PQ mandatory for all vendors **except** Government/Regulatory bodies and sister-concern organisations | Stated only in ZD/PRO/SOP-01 |
| V-003 | §2.3.1 iii | PQ valid for **two (2) years**; each vendor subsequently subject to re-qualification | Stated only in ZD/PRO/SOP-01 |
| V-004 | §2.3.1 iv | No vendor exempted from PQ unless prior approval of **Head of Supply Chain and Head of ZD** on Single Source Form | Stated only in ZD/PRO/SOP-01 |
| V-005 | §2.3.2 i | Only vendors meeting PQ criteria entered in Vendor Master Data | Stated only in ZD/PRO/SOP-01 |
| V-006 | §2.3.2 ii | Ownership of Vendor Master Data rests with Sr Manager Supply Chain | Stated only in ZD/PRO/SOP-01 |
| V-007 | §2.3.2 iii | Vendor Master reviewed **annually** to confirm completeness, no falsified information, **no duplicate vendors** | Stated only in ZD/PRO/SOP-01 |
| V-008 | §2.3.3 i | Performance evaluations performed on a **yearly** basis | Stated only in ZD/PRO/SOP-01 |
| V-009 | §2.3.3 ii | **No business transacted with vendors not having a satisfactory performance rating** | Stated only in ZD/PRO/SOP-01 |
| V-010 | §2.3.4 i | No business with persons/entities who abuse the supply chain system by corrupt, fraudulent, unfair or irregular practice | Stated only in ZD/PRO/SOP-01 |
| V-011 | §2.3.4 ii | Vendor blacklisted on true facts leading to financial loss or reputational damage; repeated non-compliance may also be grounds. **Six specific grounds listed** | Stated only in ZD/PRO/SOP-01 |
| V-012 | §2.3.4 iii | No blacklisted vendor relisted in the AVL without prior pre-qualification as laid down in the Supply Chain Manual | Stated only in ZD/PRO/SOP-01 |
| V-013 | §2.3.4 iv | Vendors may be **temporarily blocked** for minor issues. Grounds: unsatisfactory rating · not responding to Positive Balance Confirmation Request · static balance over 1 year | Stated only in ZD/PRO/SOP-01 |
| V-014 | §2.3.4 v | **Blacklisting at company level. Blocking may be at Company / Division / BU level at the discretion of CFT** | Stated only in ZD/PRO/SOP-01 |
| V-015 | §2.3.4 vi | Record of blocked/blacklisted vendors maintained, updated, and **disseminated within group entities via intranet** | Stated only in ZD/PRO/SOP-01 |
| V-016 | §2.3.5 i–ii | Obtain feedback from **all active vendors** to take their views into account. **Feedback obtained annually by IA** and shared with Head ZD | Stated only in ZD/PRO/SOP-01 |
| V-017 | §2.5 iii | **Vendor reconciliation biannually** to identify missing invoices/credit notes, prevent duplicate/over payments, identify ledger omissions, reduce queries, validate balance sheet, identify P2P issues | Stated only in ZD/PRO/SOP-01 |
| PR-009 | §2.4 i | User department raises PR in Sage; **procurement shall not be initiated without a valid PR** | Stated only in ZD/PRO/SOP-01 |
| PR-010 | §2.4 ii | RFQs **preferably** floated to prequalified vendors; quotations may be called from non-qualified vendors **for comparison purposes** | Stated only in ZD/PRO/SOP-01 |
| PR-011 | §2.4 iii | RFQs floated to the greatest extent to **all related vendors in the Approved Vendor List** | Stated only in ZD/PRO/SOP-01 |
| PR-012 | §2.4 iv | **At least three quotations** required from prequalified vendors, **except**: (a) client's only approved vendor · (b) only one vendor responded, provided RFQ was floated to all available vendors and all correspondence attached to the CST · (c) long-term agreement signed where 3 fresh quotes were obtained at signing — but rate-running contracts still require fresh quotes · (d) sole provider · (e) government/legal requirement | Stated only in ZD/PRO/SOP-01 |
| PR-013 | §2.4 v | Quotations received should be converted into a **CST** | Stated only in ZD/PRO/SOP-01 |
| PR-014 | §2.4 vi | Where fewer than three PQ quotations are received **or** the cheapest vendor is not selected, reasoning must be **clearly mentioned in the comparative** | Stated only in ZD/PRO/SOP-01 |
| PR-015 | §2.4 vii | PO raised through Sage; **no procurement initiated without prior PO approval and written acknowledgement from the vendor** | Stated only in ZD/PRO/SOP-01 |
| SO-017 | Annexure B | Vendor Qualification · Site Visit · **5% of total spend of the project** · **Top 25 vendors by spend** · QC shares rejection reports monthly · IRs shared to SC after signature by **QS, QC, CM** | Stated only in ZD/PRO/SOP-01 |
| PO-009 | §2.1.5 | PO splitting to avoid approval thresholds is mis-procurement | Stated only in ZD/PRO/SOP-01 |
| PO-010 | §3 SrMgr | Open POs no longer required closed **monthly** | Stated only in ZD/PRO/SOP-01 |
| FI-006 | `image14.png` | ZD payment chain: Invoice Received (**Performa or Final**) → Procurement compiles, **makes PV, enters JEFFI, keeps scan record** → transfers **JEFFI** + originals to Finance → Finance transfers JEFFI to **KPMG** for tax working → KPMG returns for cheque preparation / **portal uploading** → Finance submits to **IA for compliance** → **IA returns approved for signatories, or rejected for correction and resubmission** → Finance gets cheque signed and informs SC for vendor intimation | Stated only in ZD/PRO/SOP-01 |
| FI-008 | §2.5 i–ii | Procurement Section performance evaluated periodically and reported; **Supply Chain MIS shared with Head ZD as part of the Monthly Reporting Pack** | Stated only in ZD/PRO/SOP-01 |
| CP-005 | CPC | Meeting **every Thursday** following the management committee meeting | Stated only in ZD/PRO/SOP-01 |
| GV-001 | §2.6.1 i | Procurement policies and procedures **shared with all concerned employees against written acknowledgement** | Stated only in ZD/PRO/SOP-01 |
| GV-002 | §2.6.1 ii | **Compliance audit of procurement sections conducted annually** to monitor processes and check compliance against the Supply Chain Manual | Stated only in ZD/PRO/SOP-01 |
| GV-003 | §2.6.1 iii | All procurement information/data/documentation **retained with entry logs** | Stated only in ZD/PRO/SOP-01 |
| GV-004 | §2.6.1 iv | **Supply Chain Manual reviewed at minimum annually** to validate fit and identify improvements | Stated only in ZD/PRO/SOP-01 |
| GV-005 | §2.6.2 i | **Head of Supply Chain assigns and revokes system access rights. Access rights reviewed quarterly** to ensure they match job descriptions and segregation of duties is in place | Stated only in ZD/PRO/SOP-01 |
| GV-006 | §2.6.2 ii | **System interfaces tested annually** to ensure company policies and standards are enforced | Stated only in ZD/PRO/SOP-01 |
| GV-007 | §2.6.2 iii | **Vendor master data maintenance/cleansing carried out annually** to ensure information is complete, accurate, up to date and free of duplication | Stated only in ZD/PRO/SOP-01 |
| GV-008 | §2.6.3 i–ii | This manual is proprietary and must not be reproduced, changed, amended, used or copied within or outside the company. **The Business Process Owner is custodian and responsible for updates and change control** | Stated only in ZD/PRO/SOP-01 |
| GV-009 | §2.6.4 i | Any change to this document is subject to the original review/approval and distribution system **("TO BE ADDED IN COLLABORATION WITH IA")** | Stated only in ZD/PRO/SOP-01 |
| CA-001 | Annexure B | Items categorised by sequence, nature and usage in construction: **Civil · MEP · Finishing** | Stated only in ZD/PRO/SOP-01 |
| CA-002 | Annexure B | Categories further classified **Functional / Non-Functional**. Functional: Elevator, Chillers, Hot water generator, Escalators, LT Panels, Fuel transfer pump, MEP Pumps, Gensets. Non-functional: Aluminium Windows, Kitchen Cabinets, Wardrobes, Doors, Tiles, Plumbing Fixtures, ACs, Geysers | Stated only in ZD/PRO/SOP-01 |

</details>

