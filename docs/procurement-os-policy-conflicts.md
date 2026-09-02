# Policy Conflict Register

## Status — all 28 implemented as policy

Every conflict below is **implemented**, in the sense the brief requires: no
contradiction has been reconciled in code, each contested value is a policy
setting scoped to the entity, and where a document contradicts itself both
readings are held and either can be selected.

That is not the same as *settled*. A setting still running on the reading the
system chose is marked `awaiting confirmation`, and the compliance report counts
it as unconfirmed rather than compliant. There are **9** of those.

**Where it lives**

| Piece | File |
|---|---|
| Catalogue, variants, source citations, both instruments in full | `src/lib/policy.ts` |
| Storage keys and shipped readings | `src/lib/config.ts` (`CONFIG_KEYS.POLICY_*`, group `Policy · …`) |
| Per-entity values, each traceable to a passage | `scripts/seed-policy.ts` |
| The screen where the business answers | `/admin/policy-conflicts` |

Per-entity resolution needed no new table: `ConfigSetting` already carries an
optional `entityId`, and `getConfig` resolves entity override → global → shipped
reading. A ZAM value and a ZD value for the same key coexist, so every read is
entity-scoped by construction — which is what "as per policy" means when the two
companies have different policies.

**How each conflict is resolved**

| ID | Resolution | State |
|---|---|---|
| PC-001 | Per-entity interval: ZAM 3 months, ZD 12. A shared vendor is governed by the **strictest** cadence among the entities it has traded with, because vendors are not entity-scoped and a vendor selling to ZAM must satisfy ZAM. `vendorsDueForReevaluation` now reports which entity governs each vendor and when it falls due | Implemented, both explicit |
| PC-002 | Both instruments in `PERFORMANCE_INSTRUMENTS`, selectable per entity | Awaiting confirmation |
| PC-003 | Both scales in `RATING_SCALES` | Awaiting confirmation |
| PC-004 | Both methods in `QUALITY_METHODS`. The accepted-quantity variant reproduces the form **including its gap** — `qualityScore` returns null for 80–90% rather than inventing a band | Awaiting confirmation |
| PC-005 | Both scales in `INTERNAL_REFERENCE_SCALES` | Awaiting confirmation |
| PC-006 | `PQ_SECTIONS` carries the form's own sections and printed maxima; the maximum is configuration, seeded at 61 with the printed 30 kept as the qualifying score | Awaiting confirmation |
| PC-007 | Per-entity weekday: ZAM Wednesday, ZD Thursday. `ensureUpcomingMeeting` reads the entity's own value | Implemented, both explicit |
| PC-008 | Committee roster with effective dates is Phase 5; the member **types** and quorum inputs are in place now. The Faisal Nisar / Faisal Mir identity question is unchanged — no identity is inferred from a name | Partly; roster in Phase 5 |
| PC-009 | All three member types in `COMMITTEE_MEMBER_TYPES`, with `counts` and `votes` per type. Observers do not count and do not vote, per both committee tables. Quorum inputs configurable | Awaiting confirmation on Permanent Mandatory |
| PC-010 | Both chains in `PAYMENT_ROUTES`, step for step, with document sets, named external parties, reject-capable checkpoints and the Tuesday/Friday collection rule. ZAM runs Annexure A, ZD runs the JEFFI chain | Implemented, each entity's own flow |
| PC-011 | Both layouts in `COST_ANALYSIS_LAYOUTS`. The form now renders to the selected layout, and a layout that does not compute tax prints no tax row. Higher-rate reason bounded by `HIGHER_RATE_REASONS` with an Others follow-up | Awaiting confirmation |
| PC-012 | **The internal contradiction is gone.** `policy.tax_rates` is effective-dated per entity and **empty by default**, because neither SOP states a percentage. The invented `finance.default_tax_rate_percent = 18` is now 0 and documented as a data-entry pre-fill, not a rate the system asserts. With nothing configured, a form prints tax as unset and says why | Implemented; rates pending from the business |
| PC-013 | `policy.designation_map` records SOP designation → system role → organogram grade per entity. Named-post-holder questions unchanged | Mechanism in place; names pending |
| PC-014 | `policy.system_of_record` records the book of record per document type, defaulting to this system. No integration built on an ambiguous Sage/SAP reference | Implemented as a record; decision pending |
| PC-015 | Five dimensions in `CLASSIFICATION_DIMENSIONS`, held side by side with their sources. Not merged, because merging requires the mapping nobody supplied | Implemented as parallel dimensions |
| PC-016 | Per-entity route in `policy.petty_cash_route`. ZAM: HOD → Director Procurement. ZD: HOD → Sr. Manager (comparative) → Director Procurement, with the middle step flagged `awaitingConfirmation` in the data itself | Implemented; ZD step flagged |
| PC-017 | Separated, which is all the conflict needed: the per-requisition 3-quotation rule is unchanged, and the recurring two-monthly market check is now its own configured control | Implemented, both explicit |
| PC-018 | Three treatments configurable and enforced in `checkVendorEligibility`. The default permits sourcing and returns `raiseUnratedException` so the absence is recorded rather than hidden | Awaiting confirmation |
| PC-019 | Per-entity grounds in `BLACKLIST_GROUNDS`, verbatim, not merged | Implemented, both explicit |
| PC-020 | `policy.vendor_blocking_enabled` — on for ZD, off for ZAM. Scopes and grounds seeded from ZD §2.3.4 | Implemented; ZAM adoption pending |
| PC-021 | Per-entity validity, enforced in `checkVendorEligibility`. ZD 24 months; ZAM 0, meaning the control is inactive rather than ZD's rule being imposed on it | Implemented, both explicit |
| PC-022 | `cpcRequirement` reads a threshold **per transaction type** and maps procurement types onto the committee's own vocabulary. The wider mandate reading is seeded | Awaiting confirmation |
| PC-023 | The value tier is implemented — `cpcRequirement` returns `ceoRequired` above PKR 1,500,000. The classification trigger is gated behind `policy.exceptional_purchase_definition_confirmed`, false until defined | Value tier implemented; definition pending |
| PC-024 | Per-region quorum in `policy.rnc_quorum_by_region`. Central 3; **North and South null**, because image22.PNG shows 3 members in total there and the stated quorum is arithmetically impossible. Not given an invented number | Implemented as unset; decision pending |
| PC-025 | Three types in `INSPECTION_TYPES`, each carrying the column it prints under, so the data stays three-way while Annexure 4 prints two columns | Implemented; merge to confirm |
| PC-026 | `policy.monthly_requisition_owners`. IT → Procurement, Grocery and Housekeeping → Logistics, **Stationery null** — unassigned, not guessed | Implemented; owner pending |
| PC-027 | `policy.no_approver_behaviour`, seeded to escalate. `submitPr` now walks the organogram to the nearest holder of `pr.approve`, assigns them the approval and audits `PR_APPROVAL_ESCALATED`; if the chain runs out it refuses. The old auto-approve remains selectable for entities that run on it | Implemented; escalation is the new default |
| PC-028 | Fixed in Phase 1 | Resolved |

**The nine still awaiting confirmation** are PC-002, PC-003, PC-004, PC-005,
PC-006, PC-011, PC-018, PC-022 and PC-027. Each is running, each has a stated
reason, and each is one selection away from settled at `/admin/policy-conflicts`.
Choosing the value the system already picked is a valid answer — it records that
somebody checked the reading.

**What is deliberately still empty**, because filling it would be inventing a
requirement: the tax rate table, RNC quorum for North and South, the monthly
stationery owner, the prohibited role combinations (ES-025), and the definition
of an Exceptional Purchase.

---



Conflicts between the two supplied SOPs, and **within** them — several of the
most serious are contradictions between a document's narrative table and its own
annexure image.

None of these are resolved in code. Each is either already entity-scoped or must
become entity/version-scoped through the Policy Pack engine (see the remediation
plan, P0-A). Where a conflict has no safe default, the system must refuse to
guess and surface the conflict to an administrator.

**Sources**

| Ref | Document | Entity |
|---|---|---|
| ZAM | SOP-012 / ZAM/PUR/SOP-01 — Procurement SOP | Zameen Media Pvt Ltd (and Imzee Consulting) |
| ZD | SOP-ZD-SC / ZD/PRO/SOP-01 — Supply Chain SOP | Zameen Development |

**Status values:** `OPEN` · `DECISION REQUIRED` · `CONFIGURABLE — PENDING VALUES` · `RESOLVED BY CONFIGURATION`

---

## PC-001 · Vendor performance evaluation frequency

| Field | Value |
|---|---|
| Source A | ZAM §5.9 — "Vendor's performance will be evaluated after every three months" |
| Source B | ZD §5.9 — "Vendor's performance will be evaluated annually"; ZD §2.3.3 i — "Performance evaluations of vendors shall be performed on Yearly basis" |
| Entity | Differs by entity |
| Current system behaviour | Single global config `vendor.reevaluation_interval_months = 12`. ZAM's 3-month rule is not applied anywhere. |
| Risk | ZAM vendors are evaluated at a quarter of the required frequency. Any ZAM audit finding on vendor governance would be valid. |
| Recommended resolution | Effective-dated per-entity setting in the Policy Pack. ZAM = 3 months, ZD = 12 months. Compliance Scheduler generates the control at the entity's own cadence. |
| Management decision required | **No** — both documents are explicit for their own entity. Implement both. |
| Status | `CONFIGURABLE — PENDING VALUES` |

---

## PC-002 · Vendor performance instrument — criteria count and weights

**This is an intra-document conflict in both SOPs.** The narrative table and the
embedded annexure image describe two different instruments.

| Field | Value |
|---|---|
| Source A | ZAM/ZD narrative table §5.9 — **6 criteria**: Quality of Product/Service 40% · Delivery Lead Time 20% · Price Competitiveness 20% · Order Fulfillment 10% · After Sales Service 5% · Credit Offered 5% |
| Source B | ZAM/ZD embedded image `image11.png`, titled "Vendor Evaluation Criterion Weighted Average" — **5 criteria**: Quality of Parts/Products/Materials 40% · Delivery Lead Time 20% · Competitiveness of Price **30%** · Technical Support Staff's Expertise **5%** · After Sale Services 5% |
| Entity | Both entities — the same conflict appears in both documents (image is byte-identical across them) |
| Current system behaviour | Neither. 20 unweighted criteria at weight 1 / max 3 — the pre-qualification sheet is being used as the performance sheet. |
| Risk | Two defensible but different scores for the same vendor. Price is weighted 20% or 30% depending on which page is read. Order Fulfilment and Credit Offered exist in one instrument and not the other; Technical Support Expertise the reverse. |
| Recommended resolution | Model the performance instrument as a **versioned criteria set** in the Policy Pack. Seed **both** variants (`PERF-6CRIT-TEXT`, `PERF-5CRIT-ANNEX`) and require an administrator to select the effective one per entity. Do not average, merge or pick one. |
| Management decision required | **Yes** — which instrument is authoritative. |
| Status | `DECISION REQUIRED` |

---

## PC-003 · Vendor performance rating scale

| Field | Value |
|---|---|
| Source A | ZAM/ZD narrative table "Scoring Criteria for Evaluating Vendor's Performance" — **4 bands**: Unsatisfactory 0 · Development Needed 1 · Satisfactory 3 · Exceptional 5 |
| Source B | ZAM/ZD `image13.png` "Scoring Criteria for Evaluating Vendor's Technical Support Staff Expertise" — **5 bands**: Unsatisfactory 1 · Development Needed 2 · Satisfactory 3 · Above Expectations 4 · Exceptional 5 |
| Entity | Both |
| Current system behaviour | Neither scale is modelled. |
| Risk | "Unsatisfactory" scores 0 on one scale and 1 on the other; the 4-band scale has no "Above Expectations". A vendor's pass/fail can flip on scale choice alone. |
| Recommended resolution | Versioned rating scale attached to the criteria set. Seed both. |
| Management decision required | **Yes** |
| Status | `DECISION REQUIRED` |

---

## PC-004 · Quality-of-product scoring method

| Field | Value |
|---|---|
| Source A | ZAM/ZD narrative table — Quality scored by **complaint count**: 0–1 complaint = 40 · 2–3 = 30 · 4–5 = 20 · 6–7 = 10 · 7–10 = 0 |
| Source B | ZAM/ZD `image12.png` "Quality of Products/Services Scoring Criteria" — scored by **accepted quantity %**: ≥95% = 5 · ≥90% = 4 · 70–80% = 3 · below 50–70% = 2 · below 50% = 1 |
| Entity | Both |
| Current system behaviour | Neither. |
| Risk | Two unrelated measurement bases for the same 40%-weighted criterion. One counts complaints, the other measures acceptance rate — a vendor can score well on one and badly on the other. |
| Additional source defect | `image12.png` bands leave **80–90% unscored** ("70%–80%" then "below 50%–70%"). A vendor at 85% acceptance has no band. |
| Recommended resolution | Versioned scoring method per criterion. Both must be selectable; the band gap must be closed by management before the accepted-quantity method can be used. |
| Management decision required | **Yes** — method, and the 80–90% gap. |
| Status | `DECISION REQUIRED` |

---

## PC-005 · Internal reference scoring

| Field | Value |
|---|---|
| Source A | ZAM/ZD `image10.png` "Scoring Criteria for Internal Reference" — Manager **3** · Senior Manager **4** · Director or Above **5**; §5.8 text says points awarded "out of five" |
| Source B | ZAM/ZD `image20.png` Annexure 6 Vendor Selection Form — Manager **1** · Senior Manager **2** · Director or Above **4**, section headed "Marks (4)" |
| Entity | Both |
| Current system behaviour | Not modelled. |
| Risk | The section maximum is 5 or 4 depending on the page, changing the total available score. |
| Recommended resolution | The form (Annexure 6) is the instrument actually filled in; recommend it as the default, but hold both as versioned values and require confirmation. |
| Management decision required | **Yes** |
| Status | `DECISION REQUIRED` |

---

## PC-006 · Pre-qualification section marks do not sum to the stated maximum

| Field | Value |
|---|---|
| Source | ZAM/ZD `image20.png` Annexure 6. Header states **"Min. Qualifying Score: 30/60"**. Section maxima printed on the form: Tax status 10 · Company History 10 · Key Client Reference Check 12 · Payment Mode 10 · Company Registration 5 · Company Setup 10 · Internal Reference 4 |
| Arithmetic | 10+10+12+10+5+10+4 = **61**, not 60 |
| Entity | Both |
| Current system behaviour | `vendor.minimum_qualification_score = 30`, `vendor.maximum_qualification_score = 60`. The 20 seeded criteria happen to total 60 but do not match the form's sections. |
| Risk | Either a section maximum is misprinted or the stated total is. A vendor scoring 30 of an actual 61 has not met "half". |
| Recommended resolution | Rebuild the pre-qualification instrument from the form's own sections. Hold max as configuration. Flag the 61-vs-60 discrepancy for confirmation before go-live. |
| Management decision required | **Yes** — which figure is correct. |
| Status | `DECISION REQUIRED` |

---

## PC-007 · CPC meeting day

| Field | Value |
|---|---|
| Source A | ZAM CPC — "Every Wednesday followed by management committee meeting" |
| Source B | ZD CPC — "Every Thursday followed by management committee meeting" |
| Entity | Differs by entity |
| Current system behaviour | Single global `procurement.cpc_meeting_day = 3` (Wednesday). |
| Risk | ZD meetings generated on the wrong weekday. |
| Recommended resolution | Per-entity effective-dated setting. |
| Management decision required | **No** — both explicit. |
| Status | `CONFIGURABLE — PENDING VALUES` |

---

## PC-008 · CPC membership and designations

| Field | Value |
|---|---|
| Source A | ZAM CPC table — Mariam Saleem *Director Procurement*; **Faisal Nisar** *Head of Supply Chain*; **Ibrahim** *Director Marketing*; Basil *Audit Dept.* (Observer) |
| Source B | ZD CPC table — Mariam Saleem *Head of ZD*; **Faisal Mir** *Head of Supply Chain*; **Haroon Noon** *Director Design*; Basil *Associate Director Audit* (Observer) |
| Entity | Differs by entity |
| Current system behaviour | Committee members are assigned per case with a free-text `roleLabel`. No standing committee roster, no member type, no effective dates. |
| Risk | Quorum cannot be computed without a roster. Five of nine seats differ between documents. |
| Additional conflict | **Faisal Nisar vs Faisal Mir.** The loaded organogram has *Faisal Mir — Director Procurement & SCM*. Either these are two people and the organogram omits one, or ZAM's table is stale. See PC-013. |
| Recommended resolution | Standing committee roster per entity with effective dates and member type. Seed both rosters as supplied. |
| Management decision required | **Yes** — confirm whether Faisal Nisar and Faisal Mir are the same person. |
| Status | `DECISION REQUIRED` |

---

## PC-009 · Committee member types — two categories or three

| Field | Value |
|---|---|
| Source A | ZAM/ZD CPC tables — two types: **Permanent Member**, **Observer** |
| Source B | ZAM `image22.PNG` RNC composition — three types: **Permanent Mandatory Member**, **Permanent Member**, **Observer** |
| Entity | Both |
| Current system behaviour | `CpcCaseMember.required` boolean only. No type, no observer concept. |
| Risk | The quorum rule "at least 3 permanent committee members must be present in addition to the Head of the requisitioner department" is ambiguous if a third, mandatory tier exists. Whether *Permanent Mandatory* members are compulsory for quorum, or merely a subset of Permanent, is not stated. |
| Recommended resolution | Model all three types. Quorum policy expressed as a rule set per committee per entity: minimum permanent count, whether every mandatory member is required, whether observers count (they must not). Default observers to non-voting and non-counting per source. |
| Management decision required | **Yes** — the meaning of *Permanent Mandatory* for quorum. |
| Status | `DECISION REQUIRED` |

---

## PC-010 · Payment process flow and required document set

| Field | Value |
|---|---|
| Source A | ZAM `image14.PNG` "Annexure A — Payment Process Flow". Documents: **PR · PO · GRN · Invoice · Undertaking (if applicable) · GD (if applicable) · Exemptions (if applicable)** — 7 items, 3 conditional. Chain: Invoice Received → Procurement compiles → **KPMG calculates applicable taxes** → **Audit crosscheck** → Accounts books A/P → Finance prepares cheque → **Audit crosscheck complete processing** → Finance cheque signing & inform Procurement → Procurement informs vendor for collection **(Tue & Fri only)** |
| Source B | ZD `image14.png` "Process Flow for Payment Processing". Documents: **Payment Voucher · PR · PO · MIR · GRN · Invoice · CPC Approval · Undertaking (GD) · Tax Exemption Certificate** — 9 items. Chain: Invoice Received **(Performa or Final)** → Procurement compiles, **makes PV, enters JEFFI, keeps scan record** → transfer **JEFFI** + originals to Finance → Finance transfers JEFFI to **KPMG** for tax working → KPMG returns for cheque preparation / **portal uploading** → Finance submits to **IA** for compliance → IA returns approved-for-signatories **or rejected for correction and resubmission** → Finance gets cheque signed & informs SC for vendor intimation |
| Entity | Differs by entity — materially |
| Current system behaviour | Invoice → voucher → payment handoff. All 30 document types are `optional`. No IA checkpoint. No external tax step. No JEFFI. No collection-day rule. |
| Risk | The payment control chain is the most heavily controlled process in both SOPs and is the least implemented. Two Internal Audit checkpoints (ZAM) and one with an explicit rejection loop (ZD) are entirely absent. |
| Recommended resolution | Payment Pack with an entity/policy-scoped required-document matrix, and a configurable payment route with named function checkpoints. Seed both chains. |
| Management decision required | **Yes** — see also ES-008 (JEFFI) and ES-009 (KPMG tax working). |
| Status | `DECISION REQUIRED` |

---

## PC-011 · Cost Analysis form — vendor column count and computed rows

| Field | Value |
|---|---|
| Source A | ZAM/ZD `image16.png` Annexure 3 "Cost Analysis Summary" — **3 vendor columns** (Option A / B / C), 3 line rows, columns *Last PO No · Last PO Date · Last Purchase Price*, then per vendor *Rate · Qty/Unit · Total*. **No subtotal, no tax line, no net total row.** Terms rows: Delivery Time Period · Payment Terms · Quotation Validity · GST/Tax · After Sale Services/Warranties · Other Pertinent Details |
| Source B | `CS SAMPLE (2).xlsx` supplied separately — **5 vendor columns**, 5 line rows, and computed **Tax @ 16%** and **Net Total** rows |
| Entity | Unclear — the xlsx carries no entity marking |
| Current system behaviour | Built from the xlsx: 5 vendor columns, subtotal / tax / net total rows, tax default 16%, terms = Payment / Specifications / Delivery / Tax Information. |
| Risk | The implemented form is the spreadsheet's, not the SOP's. Three of the SOP's six terms rows are missing (**Quotation Validity**, **After Sale Services/Warranties**, **Other Pertinent Details**); "Specifications" is not an SOP row. `Last PO No` is missing. The tax line has no basis in the SOP annexure at all. |
| Additional finding | The SOP form's "If Higher rates are approved then reason please?" is a **bounded choice — Quality / Technical Special / Others** — not the free text currently implemented. |
| Additional source defect | Annexure 3 numbers its terms rows 1, 2, 3, **3**, 4, 5 — "Quotation Validity" and "GST/Tax" share number 3. |
| Recommended resolution | Make the form definition policy-versioned: vendor column count, line count, terms rows and whether tax is computed. Seed the SOP Annexure 3 layout as authoritative and the xlsx layout as an alternate version. Convert the higher-rate reason to a bounded list with an "Others" free-text follow-up. |
| Management decision required | **Yes** — which layout governs, and whether the xlsx supersedes Annexure 3. |
| Status | `DECISION REQUIRED` |

---

## PC-012 · Tax rate

| Field | Value |
|---|---|
| Source A | ZAM/ZD §4.8 — "In accordance with the requirements of the Income Tax Ordinance currently applicable in Pakistan." **No percentage stated.** |
| Source B | Both payment flows route tax computation to **KPMG**, an external adviser. |
| Source C | `CS SAMPLE (2).xlsx` — a **Tax @ 16%** row |
| Source D | Annexure 3 image — **GST/Tax as a per-vendor terms row**, not a computed percentage |
| Current system behaviour | `finance.default_tax_rate_percent = 18`. The Cost Analysis Form defaults to **16**. **The system contradicts itself.** |
| Risk | Neither 16 nor 18 has SOP authority. The SOPs point to statute and delegate computation to an external party — meaning no single universal rate is correct, and a hard default invites mis-statement on a financial document. |
| Recommended resolution | Effective-dated tax rate configuration per entity and tax type, with no system-wide default applied silently to a printed form. Where the applicable rate is not configured, the form must show the field as unset rather than assume. Reconcile the 16-vs-18 internal inconsistency as part of P0. |
| Management decision required | **Yes** — the applicable rates and their effective dates. |
| Status | `DECISION REQUIRED` — and a live internal inconsistency to fix in P0 |

---

## PC-013 · Organisational terminology and named post-holders

| Field | Value |
|---|---|
| Source A | ZAM — Mariam Saleem *Director Procurement*; Faisal Nisar *Head of Supply Chain*; roles named *Director / Senior Manager Procurement*, *Manager Logistics* |
| Source B | ZD — Mariam Saleem *Head of ZD*; Faisal Mir *Head of Supply Chain*; roles named *Head of Supply Chain*, *Sr. Manager Procurement*, *Buying Specialist*, *Project Procurement Manager (PPM)* |
| Source C | Supplied organograms — Mariam Saleem *Sr. Director Procurement & SCM*; Faisal Mir *Director Procurement & SCM*; Ali Mehmood *Assistant Director Procurement & SCM* |
| Entity | Both, plus the organogram as a third source |
| Current system behaviour | Organogram loaded with 13 grades from the slides. Role titles in `ROLE_DEFINITIONS` are generic (`PROCUREMENT_DIRECTOR`, `PROCUREMENT_SENIOR_MANAGER`) and do not carry SOP wording. |
| Risk | Three different titles for the same person across three sources. Approval routing that names a role cannot be validated against the SOP without a mapping. **"Buying Specialist"** and **"PPM"** appear in ZD responsibilities and have no counterpart role in the system. |
| Recommended resolution | A designation-mapping table per entity and policy version: SOP designation → system role → organogram grade. Add `BUYING_SPECIALIST` and `PROJECT_PROCUREMENT_MANAGER` roles scoped to ZD. Never infer identity from a name. |
| Management decision required | **Yes** — confirm Faisal Nisar vs Faisal Mir, and Mariam Saleem's current designation per entity. |
| Status | `DECISION REQUIRED` |

---

## PC-014 · Named ERP

| Field | Value |
|---|---|
| Source A | ZD §2.4 i, §2.4 vii — "User department shall raise PR in **Sage**"; "Purchase Order … shall be raised through **Sage**"; "Generate Purchase Order in **Sage**" |
| Source B | ZD Annexure B process flow — "User department shall raise PR in **SAP**" |
| Source C | ZAM `image18.png` — "Item Groups – Planned for **sage 300**" |
| Source D | ZAM/ZD §4.7 — GRN prepared "through **ERP System**" (unnamed); Store Process Flow — "RTV document will be lodged … within the **ERP**" |
| Entity | ZD contains both Sage and SAP; ZAM names Sage 300 |
| Current system behaviour | ProcurementOS is the system of record. No external ERP integration exists. |
| Risk | If Sage/SAP remains the book of record for PR/PO, ProcurementOS is either the master or a parallel system, and duplicate entry or divergence follows. This is an architecture question, not a feature. |
| Recommended resolution | Do not build an integration on an ambiguous reference. Record the system-of-record per entity and per document type as configuration, and log this for management decision. |
| Management decision required | **Yes** — is ProcurementOS the system of record, or does it feed Sage/SAP? |
| Status | `DECISION REQUIRED` |

---

## PC-015 · Item and inspection category taxonomies do not align

Three different category lists appear across the same documents, and no mapping
between them is supplied.

| Taxonomy | Source | Values |
|---|---|---|
| Sage item groups (7) | ZAM `image18.png` | ELT Electronics · HDW Hardware · HKG Housekeeping & Grocery · PNT Printing Material · STA Stationary & Giveaways · ACC Accessories · ITE IT Equipment |
| Stacking main categories (10) | ZAM `image19.emf` Table 1.1 | Electronics · Hardware · Grocery · Housekeeping · Stationery · Giveaways · IT Equipment · Furniture & Fixture · Branding Material · Printing Material |
| Inspection matrix columns (7) | ZAM/ZD Store Process Flow | Stationery · Giveaways · Furniture · Housekeeping & Grocery · IT/Network/Mobiles · Electronic Appliances · Printed Collateral |
| Construction categories (3 + 2 classes) | ZD Annexure B | Civil · MEP · Finishing; Functional / Non-functional |

| Field | Value |
|---|---|
| Risk | The stacking list splits Grocery from Housekeeping and Stationery from Giveaways where Sage groups them, adds Furniture & Fixture and Branding Material, and drops Accessories. The inspection matrix uses a fourth set of labels. A single Category master cannot drive inspection routing, stacking rules and Sage grouping without an explicit mapping. |
| Current system behaviour | One `Category` tree with `requiresInspection` and `inspectionTemplate`. No mapping to any of the four taxonomies. |
| Recommended resolution | Keep one Category master and add **classification dimensions** (sage group, stacking category, inspection class, construction class) as attributes. Seed all four lists as supplied. Do not force them into one hierarchy. |
| Management decision required | **Yes** — the mapping between the four lists. |
| Status | `DECISION REQUIRED` |

---

## PC-016 · Petty cash approval chain — Director Procurement vs policy authority

| Field | Value |
|---|---|
| Source A | ZAM/ZD §4.4.1 text — HOD approval, then **"approved by Director procurement"** |
| Source B | ZAM `image15.png` Annexure 2 flow — "Obtain Approval on Petty Cash from Requester HOD" → "Obtain Approval of **Dir. Procurement**" → "Submit Approved Form and Collect Cash from **Accounts**" |
| Source C | ZD Sr. Manager Procurement responsibilities — "Review and approve manual comparative Statement for procurement through petty cash" |
| Entity | Both; ZD adds a Sr. Manager step not in the flow diagram |
| Current system behaviour | 14-stage lifecycle with configurable approval. `createPettyCash` has **no permission check**. |
| Risk | ZD's Sr. Manager comparative-approval duty is not represented in the two-step flow, so the ZD chain may require three approvals rather than two. |
| Recommended resolution | Per-entity petty cash approval route in the Policy Pack. Seed ZAM as HOD → Director Procurement; seed ZD as HOD → Sr. Manager (comparative) → Director Procurement, flagged for confirmation. |
| Management decision required | **Yes** — the ZD chain. |
| Status | `DECISION REQUIRED` |

---

## PC-017 · Price comparison cadence versus per-transaction quotation rule

| Field | Value |
|---|---|
| Source A | ZAM/ZD §5.11 — "'Price Comparison' should be conducted after every **two months** by taking 3 quotes" |
| Source B | ZAM/ZD §4.5.1 — "at least **3 comparative quotations** will be finalized" per requisition |
| Entity | Both |
| Current system behaviour | Per-requisition minimum of 3 quotations is enforced. The recurring two-monthly market check does not exist. |
| Risk | These are two distinct controls that the system currently conflates into one. Satisfying the per-PR rule does not satisfy the standing market check, and an auditor would find the latter absent. |
| Recommended resolution | Keep the per-PR rule. Add a separate recurring **Price Competitiveness Review** control through the Compliance Scheduler, with its own evidence. |
| Management decision required | **No** — both are explicit and non-conflicting once separated. |
| Status | `CONFIGURABLE — PENDING VALUES` |

---

## PC-018 · Vendor evaluation trigger — post-selection versus periodic

| Field | Value |
|---|---|
| Source A | ZAM/ZD §5.9 — "**After being selected**, Vendor's performance will be evaluated after every three months / annually" |
| Source B | ZD §2.3.3 ii — "**No business shall be transacted with vendors not having satisfactory performance rating**" |
| Entity | Both |
| Current system behaviour | Evaluations are recorded ad hoc. No gate prevents sourcing from a vendor with an unsatisfactory or absent performance rating. |
| Risk | ZD's rule is a hard prohibition. Without it, a vendor rated unsatisfactory can still be invited and awarded. But applying it strictly would block every newly approved vendor, which has no rating yet — the SOP does not say how a first-time vendor is treated. |
| Recommended resolution | Implement the gate as configurable, with an explicit policy choice for "no rating yet" (block / allow / allow with exception case). Do not guess. |
| Management decision required | **Yes** — treatment of vendors with no performance rating. |
| Status | `SOURCE CLARIFICATION REQUIRED` |

---

## PC-019 · Blacklisting grounds

| Field | Value |
|---|---|
| Source A | ZAM §5.14 — five grounds: forged documents · consistent quality compromise · **variance in price on invoice and quantity** · consistent partial or late deliveries · other reasons |
| Source B | ZD §2.3.4 ii — six grounds: conviction of fraud/corruption/misappropriation/theft/forgery/bribery · corrupt practices obtaining a contract · **court/tribunal finding of tax evasion** · wilful failure to perform per contract · failure to remedy underperforming contracts · **notified/suspended/debarred by Government or PPRA** |
| Entity | Differs by entity |
| Current system behaviour | `reasonCode` free enumeration on blacklist cases; the two lists are not seeded. |
| Risk | ZD's grounds are materially stronger and reference external authority (PPRA). ZAM's are performance-based. Using one entity's list for the other would be wrong. |
| Recommended resolution | Per-entity seeded reason codes in the Policy Pack. |
| Management decision required | **No** — both explicit. |
| Status | `CONFIGURABLE — PENDING VALUES` |

---

## PC-020 · Blocking exists only in ZD

| Field | Value |
|---|---|
| Source A | ZD §2.3.4 iv–vi — temporary **blocking** for minor issues, distinct from blacklisting; blocking may be done at **Company / Division / BU level at the discretion of CFT**; blacklisting at company level only. Grounds: unsatisfactory performance rating · not responding to positive balance confirmation · static balance over 1 year |
| Source B | ZAM — **no blocking concept at all** |
| Entity | ZD only |
| Current system behaviour | Single `SUSPENDED` status, no scope, no grounds, no unblock workflow. |
| Risk | Implementing blocking globally would impose a ZD control on ZAM without authority. Not implementing it leaves ZD non-compliant. |
| Recommended resolution | Build blocking as an entity-scoped capability, enabled for ZD, disabled for ZAM until instructed. "CFT" discretion requires definition — see ES-010. |
| Management decision required | **Yes** — whether ZAM adopts blocking. |
| Status | `DECISION REQUIRED` |

---

## PC-021 · Pre-qualification validity exists only in ZD

| Field | Value |
|---|---|
| Source A | ZD §2.3.1 iii — "Pre-qualification of vendor shall be valid for a period of **two (2) years**" with mandatory re-qualification |
| Source B | ZAM §5.1 — pre-qualification process described with **no validity period** |
| Entity | ZD explicit; ZAM silent |
| Current system behaviour | No expiry. Once approved, indefinitely approved. |
| Risk | Applying 2 years to ZAM invents a requirement. Not applying it to ZD is non-compliance. |
| Recommended resolution | Per-entity validity setting. ZD = 24 months. ZAM = unset, with the control inactive until instructed. |
| Management decision required | **Yes** — whether ZAM adopts a validity period. |
| Status | `DECISION REQUIRED` |

---

## PC-022 · CPC mandate scope — goods only or all transactions

| Field | Value |
|---|---|
| Source A | ZAM/ZD CPC "Engagement Limit: **Procurement of Goods** — Greater than or Equal to PKR 500,000" |
| Source B | ZAM/ZD CPC "Mandate: **Any transaction** including but not limited to: SLA · Service Contracts · AMC · Buildouts · Onetime Purchases · Exceptional Purchases (Must be approved by CEO)" |
| Entity | Both |
| Current system behaviour | Threshold applies to requisition value irrespective of type. |
| Risk | The engagement limit says goods; the mandate says any transaction including services and contracts. Whether a PKR 400,000 service contract requires CPC is unresolved. |
| Recommended resolution | Threshold rules per transaction type in the Policy Pack, so goods and services can carry different limits. Seed both readings and require confirmation. |
| Management decision required | **Yes** |
| Status | `DECISION REQUIRED` |

---

## PC-023 · "Exceptional Purchases" CEO approval versus the 1.5M tier

| Field | Value |
|---|---|
| Source A | ZAM/ZD CPC Mandate — "**Exceptional Purchases (Must be approved by CEO)**" — no value stated |
| Source B | ZAM/ZD CPC ToR — "All purchases **above PKR 1,500,000** are to be approved by Office of CEO" |
| Entity | Both |
| Current system behaviour | Neither. No CEO tier exists. |
| Risk | Two independent CEO triggers: a value threshold and a transaction classification. "Exceptional" is undefined — see ES-011. A PKR 200,000 exceptional purchase may require the CEO. |
| Recommended resolution | Implement the value tier now (unambiguous). Implement the classification trigger as a flag whose definition is pending. |
| Management decision required | **Yes** — definition of "Exceptional Purchase". |
| Status | `SOURCE CLARIFICATION REQUIRED` |

---

## PC-024 · RNC quorum wording

| Field | Value |
|---|---|
| Source A | ZAM RNC — "At least 3 permanent committee members **for central region** must be present in addition to the **Head of the Committee**" |
| Source B | ZAM CPC — "At least 3 permanent committee members must be present in addition to the **Head of the requisitioner department**" |
| Source C | ZAM `image22.PNG` — North and South regions have only **3 members each** in total |
| Entity | ZAM |
| Current system behaviour | No committee quorum of any kind. |
| Risk | North and South RNC rosters have three members total. If quorum is "3 permanent plus the Head of the Committee", those regions can never form a quorum from their own roster. Also, RNC requires the *Head of the Committee* while CPC requires the *Head of the requisitioner department* — different roles, and "Head of the Committee" is not identified in the roster. |
| Recommended resolution | Per-committee, per-region quorum rules. Do not assume the CPC rule applies to RNC. Flag the North/South arithmetic for management. |
| Management decision required | **Yes** — RNC quorum for North and South, and who is Head of the Committee. |
| Status | `SOURCE CLARIFICATION REQUIRED` |

---

## PC-025 · Store inspection ownership versus inspection-type naming

| Field | Value |
|---|---|
| Source A | ZAM/ZD Store Process Flow matrix — inspection types **Technical · Qualitative · Quantitative**, owners Store / Admin / IT across 7 goods types |
| Source B | ZAM `image17.png` Annexure 4 Goods Inspection Note — inspection types printed as **QUANTITATIVE** and **QUALITATIVE/TECHNICAL** (two columns, qualitative and technical combined), each with PASSED / REJECTED |
| Entity | Both |
| Current system behaviour | Single `inspectionType` defaulting to `GENERAL`. |
| Risk | The matrix treats technical and qualitative as separate inspections with potentially different owners (furniture: Admin for both; IT: IT for both — but they could diverge). The form merges them into one column. A form built to the matrix cannot be recorded on the form as printed. |
| Recommended resolution | Model three inspection types per the matrix, and render the form with qualitative and technical adjacent so the printed layout is preserved. Flag the merge for confirmation. |
| Management decision required | **Yes** |
| Status | `SOURCE CLARIFICATION REQUIRED` |

---

## PC-026 · Requisition ownership for monthly repeat orders

| Field | Value |
|---|---|
| Source A | ZAM/ZD §4.1 — monthly requisitions "are generated by **procurement (IT equipment)** and **logistics team (only grocery & house-keeping)**" |
| Source B | ZAM/ZD §4.1 — "Monthly requisitions will comprise the requirement of general supplies like **Grocery, housekeeping, stationery and IT accessories**" |
| Entity | Both |
| Current system behaviour | No monthly generation. |
| Risk | The first sentence assigns two categories to two owners; the second lists four categories. **Stationery has no named owner.** |
| Recommended resolution | Category-to-owner mapping as configuration. Seed IT equipment → Procurement, Grocery + Housekeeping → Logistics, Stationery → **unassigned, pending decision**. |
| Management decision required | **Yes** — who owns the monthly stationery requisition. |
| Status | `SOURCE CLARIFICATION REQUIRED` |

---

## PC-027 · A requisition can reach APPROVED with no human approver

**Type:** `DECISION REQUIRED` — system behaviour with no source authority


**What the system does.** `submitPr` asks the approval engine for an approver. If
the engine returns none — no rule matched the entity, department, category,
procurement type and amount — or if `approval.department_approval_required` is
off for the entity, the requisition is driven straight through
UNDER_DEPARTMENT_APPROVAL to APPROVED and on to PROCUREMENT_REVIEW **in the same
call, on the submitter's own authority**. A requester with no approval permission
whatsoever ends up with an approved requisition.

**What the source says.** Neither SOP contemplates this. ZAM §3.1 and the ZD
equivalent both describe departmental approval as a step somebody performs. No
passage says what happens when no approver can be identified, and no passage
authorises proceeding without one.

**Why it survived Phase 1.** Removing it would have broken every seeded flow and
any live entity whose approval matrix is incomplete — the brief forbids
weakening working functionality, and this *is* the working behaviour. So the
transition now travels on a declared authority, `cascade: "approval engine: no
applicable approver"`, which is written into the audit trail. The behaviour is
unchanged; it is no longer invisible. Searching the audit log for that phrase
lists every requisition that was approved by nobody.

**The three options.**

1. **Refuse.** No approver identified means the requisition cannot be submitted,
   and the submitter is told which rule is missing. Safest, and will block work
   the day an approval matrix has a gap.
2. **Escalate.** Fall back to the line manager from the organogram, then upward
   until somebody with `pr.approve` is found. Uses data that already exists, and
   turns a silent auto-approval into a real approval.
3. **Keep, bounded.** Auto-approve only below a stated value, and raise an
   exception every time. Preserves throughput and puts a ceiling on it.

**Recommendation.** Option 2, with option 1 as the fallback when the chain runs
out — the organogram loaded in commit `ebdfc0a` already gives every one of the 24
people a reporting line, so the data to do it is present.

**Blocks:** PR-002, AP-001. **Needs:** a decision, and ES-001 for option 3's
threshold.

---

## PC-028 · Starting sourcing required only a read permission

**Type:** `CONFIGURABLE — RESOLVED IN PHASE 1`, recorded because it changed behaviour

**What the system did.** `startSourcing` admitted anybody holding **either**
`rfq.issue` **or** `pr.view_all`. The second is a read permission — it is what
lets somebody see requisitions outside their own department. So a read-only
holder of `pr.view_all`, including the audit role, could move a requisition into
SOURCING.

**What changed.** `transitionPr` now requires the authority for the state being
entered, and entering SOURCING requires `rfq.issue`. The looser check in
`startSourcing` no longer decides the outcome.

**Who this affects.** Any account holding `pr.view_all` without `rfq.issue`:
`AUDIT_USER`, `FINANCE_APPROVER`, `MANAGEMENT_COMMITTEE`. None of them should be
starting a sourcing exercise, so this is recorded as a fix rather than a
regression — but it is a behaviour change and somebody should confirm no live
workflow depended on it.

**Recommendation.** Accept. If any of those roles genuinely needs to start
sourcing, grant it `rfq.issue` explicitly rather than reinstating the read-based
route.

---

## Summary

| Status | Count |
|---|---|
| `DECISION REQUIRED` | 18 |
| `SOURCE CLARIFICATION REQUIRED` | 5 |
| `CONFIGURABLE — PENDING VALUES` | 4 |
| `CONFIGURABLE — RESOLVED IN PHASE 1` | 1 |
| **Total** | **28** |

> **Correction.** The Phase 0 version of this table read 14 / 5 / 4 = 23 against
> 26 entries. It was wrong: the `DECISION REQUIRED` count was short by four and
> the total by three. The figures above are counted from the entries themselves
> and are re-counted by script on every edit. The practical difference is that
> **18 conflicts need a management decision, not 14.**

Three of these — **PC-002, PC-003, PC-004** — are contradictions between a
document's narrative text and its own embedded annexure image, and would not have
been found by reading the extracted text alone.

**PC-012 (tax rate) additionally records a live inconsistency the system itself
introduced:** configuration says 18%, the Cost Analysis Form says 16%, and
neither has SOP authority. That part is a P0 fix, not merely a conflict to log.
