# External Source Register

Documents, systems and authorities that the two supplied SOPs rely on but which
have **not been supplied**. Every requirement whose behaviour depends on one of
these is marked `EXTERNAL SOURCE REQUIRED` in the compliance matrix and is not
implemented on assumption.

Per the brief: organisational procurement compliance cannot be claimed complete
while any row below is outstanding.

**Status values:** `NOT SUPPLIED` · `PARTIALLY INFERABLE` · `SUPPLIED`

---

## ES-001 · Financial Authority Limits Policy

| Field | Value |
|---|---|
| Referenced at | ZD §3 Head of Supply Chain — "Review and approved Purchase Orders as per **Financial Authority Limits Policy**"; ZD §3 Sr. Manager Procurement — same wording |
| What depends on it | The **entire PO approval matrix**. Which role may approve a PO at which value, for which entity and transaction type. Also referenced for voucher and payment authority. |
| What the system does now | Two configurable thresholds — `approval.po_senior_manager_threshold` and `approval.po_director_threshold` — plus 16 configurable approval rules with steps. These are *plausible* values that were not taken from any supplied document. |
| Risk of proceeding without it | **High.** Every PO approval in the system is routed against invented limits. A PO approved by a Senior Manager may in fact require a Director, or the CEO. This is the single most consequential missing document. |
| What I need | The limits table: role × value band × entity × transaction type, with effective dates. |
| Status | `NOT SUPPLIED` |

---

## ES-002 · Supply Chain Manual

| Field | Value |
|---|---|
| Referenced at | ZD §3 Sr. Manager Procurement — "Maintain record of all information / data / documentation pertaining to procurement **as referred in Supply Chain Manual**"; ZD §2.3.4 iii — "No Blacklisted vendor shall be relisted … without prior Pre-Qualification **as laid down in Supply Chain Manual**"; ZD §2.6.1 iii — "All information / data / documentation pertaining to Procurement **as referred in Supply Chain Manual** shall be retained with entry logs"; ZD §2.6.1 iv — "**Supply Chain Manual** shall, at minimum be reviewed on annual basis" |
| What depends on it | The **record-retention schedule** (what is retained, for how long, with what entry logs). The **relisting criteria** for a blacklisted vendor. The scope of the annual manual review control. |
| What the system does now | Documents are stored with an access log; there is no retention schedule, no archival policy and no defined relisting gate beyond "requires fresh pre-qualification". |
| Risk of proceeding without it | **High.** Retention periods cannot be invented — they are frequently statutory. Implementing a guess creates a false compliance signal. |
| What I need | The retention schedule and the relisting criteria. |
| Status | `NOT SUPPLIED` |

---

## ES-003 · Code of Conduct

| Field | Value |
|---|---|
| Referenced at | ZD §2.1.2 i — "contrary to Zameen Development's Values and **Code of Conduct**"; ZD §2.1.3 i — gifts "unless within Zameen Development's **Code of Conduct Policy** on accepting gifts, hospitality and entertainment"; ZD §2.1.3 iii — "should be reported in accordance with **Code of Conduct Policy**"; ZD §2.1.7 — "All staff is required to strictly comply with **Code of Conduct**" |
| What depends on it | The **gift and hospitality thresholds and reporting rules**. What may be accepted, above what value it must be declared, to whom, and within what period. |
| What the system does now | Nothing. No gifts register. |
| Risk of proceeding without it | **Medium-high.** The brief explicitly says not to invent monetary thresholds absent from source. A register can be built; the *rules* it enforces cannot. |
| What I need | Gift/hospitality acceptance limits and the declaration process. |
| Status | `NOT SUPPLIED` |

---

## ES-004 · Whistle Blowing Policy

| Field | Value |
|---|---|
| Referenced at | ZD §2.1.2 iii — "Employees shall raise any suspicion of Bribery, Corruption or Fraud … in accordance with Zameen Development's **Whistle Blowing Policy**" |
| What depends on it | The escalation route, anonymity guarantees, protected-disclosure handling and the recipient of a report. |
| What the system does now | Nothing. |
| Risk of proceeding without it | **High if built wrongly.** A whistleblowing channel with incorrect confidentiality handling is worse than none. The brief says not to build a replacement platform. |
| What I need | Confirmation of whether reports are handled inside this system at all, and if so by whom. |
| Status | `NOT SUPPLIED` |

---

## ES-005 · ZAM/PUR/PF-01 — Process Flow document

| Field | Value |
|---|---|
| Referenced at | ZAM §6 and ZD §6 — "Further to below attachments there is a document **ZAM/PUR/PF-01**, which contains all process flows." |
| What depends on it | The authoritative process flows. The supplied documents contain four flow diagrams (petty cash, ZAM payment, ZD payment, store receiving as text). PF-01 is said to contain **all** of them — implying flows exist that were not supplied. |
| What the system does now | Implements the flows visible in the supplied material. |
| Risk of proceeding without it | **Medium.** Unknown unknowns: there may be documented flows for sourcing, receiving, disposal or contracting that impose steps not present in the SOP narrative. |
| What I need | ZAM/PUR/PF-01. |
| Status | `NOT SUPPLIED` |

---

## ES-006 · Vendor Performance Evaluation Form

| Field | Value |
|---|---|
| Referenced at | ZD §2.3.3 ii — "as laid down in Vendor Performance Evaluation Form. **(Form To Be Attached)**" — the source itself records the form as missing |
| What depends on it | The performance instrument's **exact layout, field list and signature block**. The criteria and weights are partly inferable from the narrative table and `image11.png`, but those two disagree — see PC-002. |
| What the system does now | Uses the pre-qualification criteria set as the performance instrument. Incorrect. |
| Risk of proceeding without it | **High.** The form is the instrument. Building from two conflicting summary tables produces a third variant that matches neither. |
| What I need | The form. Until then, PC-002/PC-003/PC-004 cannot be closed. |
| Status | `NOT SUPPLIED` — and acknowledged as missing by the source document itself |

---

## ES-007 · Vendor Pre-Qualification Criteria — "Annexure 6" as referenced by ZD

| Field | Value |
|---|---|
| Referenced at | ZD §2.3.1 i — "unless it meets recommended requirements for Vendor Pre-qualification as laid down in **Vendor PQ Criteria (Annexure 6)**" |
| What depends on it | Whether ZD uses the **same** Annexure 6 as ZAM. The Vendor Selection Form image (`image20.png`) is present **only in the ZAM document** — it is not embedded in the ZD file. |
| What the system does now | Applies one pre-qualification criteria set to both entities. |
| Risk of proceeding without it | **Medium.** ZD may use a different PQ instrument. The ZAM form is headed "ZAMEEN MEDIA PVT LTD. / Imzee Consulting" — on its face it is not a ZD form. |
| What I need | ZD's Annexure 6, or confirmation that ZAM's applies. |
| Status | `NOT SUPPLIED` |

---

## ES-008 · JEFFI

| Field | Value |
|---|---|
| Referenced at | ZD payment flow (`image14.png`) — "Procurement Compile Set of Documents for Payment, Make PV, Enter **JEFFI** & Keep Scan Record"; "Transfer **JEFFI** & Original Set of Documents to the Finance"; "Finance Transfer **JEFFI** to KPMG For Tax Working" |
| What depends on it | A mandatory artefact or system in the ZD payment chain, sitting between voucher preparation and tax computation. It is transferred physically or digitally, and is prerequisite to the Finance and KPMG steps. |
| What the system does now | Nothing. The term appears nowhere in the codebase. |
| Risk of proceeding without it | **High for ZD payments.** A required step in the payment control chain cannot be modelled without knowing whether JEFFI is a form, a register, a system or a file naming convention. |
| What I need | Definition of JEFFI: what it is, who produces it, what it contains, and whether it is a document to be attached or an external system entry. |
| Status | `NOT SUPPLIED` — **term is undefined in both documents** |

---

## ES-009 · KPMG tax working arrangement

| Field | Value |
|---|---|
| Referenced at | ZAM `image14.PNG` — "**KPMG** - Calculate Applicable Taxs -"; ZD `image14.png` — "Finance Transfer JEFFI to **KPMG** For Tax Working"; "KPMG return to Finance For Cheque Preparation / **Portal Uploading**" |
| What depends on it | Tax computation on every payment is performed by an **external adviser**, not by the system. This is why no universal tax rate can be hard-coded (see PC-012). Also an unnamed **portal** receives uploads. |
| What the system does now | A `finance.default_tax_rate_percent` of 18 and a Cost Analysis Form defaulting to 16 — both invented, both inconsistent. |
| Risk of proceeding without it | **High.** The system currently computes tax figures that, per the SOP, it has no authority to compute. |
| What I need | Whether the system should (a) record the externally-computed figure, (b) compute a provisional figure for comparison, or (c) not compute tax at all. Plus the identity and interface of the portal. |
| Status | `NOT SUPPLIED` |

---

## ES-010 · CFT — Cross Functional Team as a blocking authority

| Field | Value |
|---|---|
| Referenced at | ZD §2.3.4 v — "blocking can be done at Company / Division / BU level **at the discretion of CFT**" |
| What depends on it | Who may block a vendor, and at what organisational scope. |
| Ambiguity | ZAM uses "Cross Functional Committee (CFC)" for build-outs with a named proxy roster (`image21.PNG`). ZD uses "CFT" for vendor blocking discretion. Whether these are the same body is not stated. |
| What the system does now | Nothing. No blocking, no CFT. |
| Risk of proceeding without it | **Medium.** Assigning blocking authority to the wrong body creates an invalid control. |
| What I need | CFT composition and authority, and whether CFT and CFC are the same body. |
| Status | `NOT SUPPLIED` |

---

## ES-011 · Definition of "Exceptional Purchases"

| Field | Value |
|---|---|
| Referenced at | ZAM/ZD CPC Mandate — "**Exceptional Purchases (Must be approved by CEO)**" |
| What depends on it | A CEO approval trigger that is independent of the PKR 1,500,000 value tier. Without a definition, the trigger cannot fire. |
| What the system does now | No CEO tier at all. |
| Risk of proceeding without it | **Medium.** The value tier is implementable now; this classification trigger is not. |
| What I need | The criteria that make a purchase "exceptional". |
| Status | `NOT SUPPLIED` — see PC-023 |

---

## ES-012 · Positive Balance Confirmation Request

| Field | Value |
|---|---|
| Referenced at | ZD §2.3.4 iv b — a vendor may be blocked for "Not responding to the '**Positive Balance Confirmation Request**' from Company / Company Auditor" |
| What depends on it | A blocking ground, and by implication a balance-confirmation process run by the company or its auditor. |
| What the system does now | Nothing. Vendor reconciliation is also absent (ZD §2.5 iii). |
| Risk of proceeding without it | **Low-medium.** The blocking ground can be recorded manually; the confirmation process itself is a finance exercise that may sit outside this system. |
| What I need | Whether balance confirmation is in scope for this system. |
| Status | `NOT SUPPLIED` |

---

## ES-013 · Approved legal terms and conditions

| Field | Value |
|---|---|
| Referenced at | ZD Buying Specialist — "**Approved terms & condition (Legal)** must be shared along with the PO including payment terms & delivery date"; ZAM Build-out Roles — Legal Team "Contract creation" |
| What depends on it | The actual legal text attached to and versioned with each PO, and the contract templates for the Contracts module. |
| What the system does now | No legal terms on the PO. No contract templates. |
| Risk of proceeding without it | **Medium.** The mechanism (versioned terms attached to a PO version) is buildable; the content is not mine to write. |
| What I need | The approved T&C text and version history, and contract templates by type. |
| Status | `NOT SUPPLIED` |

---

## ES-014 · Annexure 1 — Purchase Requisition Form as an image

| Field | Value |
|---|---|
| Referenced at | ZAM/ZD Annexure 1 |
| What depends on it | The printed PR layout. |
| Note | The PR form **is** supplied — as a Word table in the document text, not as an image, and I have read it in full: Document Date · Required Date · Document No · Department · Description/Comments · Req Location · Required By · Approved By · Approval Status · then Sr.No · Item Code · Description · Additional Comments · Qty · UOM · Unit Cost · Total Cost · In Stock · then Document Comments · HOD/Regional Head Sign · Date · Stamp · Time, with the note that Stamps, Date and Time are compulsory. |
| Status | `SUPPLIED` — recorded here only to confirm it is **not** an outstanding dependency |

---

## ES-015 · Regional structure

| Field | Value |
|---|---|
| Referenced at | ZAM `image22.PNG` — RNC composed by **Central / North / South Region**; ZAM CFT roster — "Sales Central / Sales North / Sales South"; ZAM Store Keeping — "Stacking & Sorting & Movement **across regions**"; ZAM Scrap — "collected and delivered to the **regional hub**"; ZAM Annexure 1 — "HOD / **Regional Head**" |
| What depends on it | A Region entity above Site/Store. RNC quorum is region-scoped. Regional heads approve requisitions. Scrap moves to regional hubs. |
| What the system does now | Entities → Departments / Sites / Stores. **No Region.** |
| Risk of proceeding without it | **Medium.** Region can be modelled, but the actual region list, which sites belong to which region, and which store is each region's hub are unknown. |
| What I need | The region list, site-to-region mapping, and regional hub designations. |
| Status | `PARTIALLY INFERABLE` — three regions named (Central, North, South); membership unknown |

---

## ES-016 · Undertaking and Goods Declaration forms

| Field | Value |
|---|---|
| Referenced at | ZAM Annexure A document set — "Undertaking (if applicable)", "GD (Goods Declaration if applicable)"; ZD payment flow — "Undertaking (GD)" |
| What depends on it | Two payment-pack documents, and the conditions under which each becomes applicable. |
| Ambiguity | ZAM lists Undertaking and GD as **two separate** conditional documents; ZD writes "**Undertaking (GD)**" as one item, implying they are the same thing. |
| What the system does now | Neither document type exists. |
| Risk of proceeding without it | **Medium.** The applicability condition is what makes a conditional document requirement work. "If applicable" is not a rule. |
| What I need | Both forms, and the conditions that make each mandatory. |
| Status | `NOT SUPPLIED` |

---

## ES-017 · Tax Exemption Certificate / SRO evidence

| Field | Value |
|---|---|
| Referenced at | ZD payment flow — "**Tax Exemption Certificate**" in the required set; ZAM Annexure A — "Exemptions (if applicable)"; ZAM/ZD §5.2.1 3) — "'SRO's/Exemptions' (applicable for import vendors only) … an exemption certificate needs to be provided" |
| What depends on it | A payment-pack document, and 2 points on the pre-qualification tax-status score. |
| What the system does now | Vendor `taxStatus` exists; no exemption certificate handling. |
| Risk of proceeding without it | **Low-medium.** The document slot is buildable; validity periods and verification are not defined. |
| What I need | Whether exemption certificates carry expiry and who verifies them. |
| Status | `NOT SUPPLIED` |

---

## ES-018 · Sage 300 / SAP interface specification

| Field | Value |
|---|---|
| Referenced at | See PC-014 for the full conflict. ZD names Sage and SAP for PR/PO; ZAM names Sage 300 for item groups; §4.7 names an unnamed "ERP System" for GRN; Store Process Flow names "the ERP" for RTV. |
| What depends on it | Whether this system is the book of record or a feeder. ZD §2.6.2 ii additionally requires "**System interfaces shall be tested annually**" — implying interfaces exist and must be evidenced. |
| What the system does now | Heimdall is standalone. No integration. The annual interface test control has nothing to test. |
| Risk of proceeding without it | **High architecturally.** If Sage remains the book of record, every PR and PO in Heimdall is a duplicate. |
| What I need | The system-of-record decision and, if integration is in scope, the interface specification. |
| Status | `NOT SUPPLIED` |

---

## ES-019 · Item master and item-code scheme

| Field | Value |
|---|---|
| Referenced at | ZAM Annexure 1 — "**Item Code**" column on the PR; ZAM `image18.png` — 7 Sage 300 item groups with GROUPID codes (ELT, HDW, HKG, PNT, STA, ACC, ITE) and 11 units of measure |
| What depends on it | The item-code format and the group-to-code rule. `masters.ts` contains `itemCodeRuleFor`, `nextItemCode` and `deriveItemCode` — currently orphaned with no UI. |
| What the system does now | Items exist with a free `sku`. The code-rule engine is unreachable. |
| Risk of proceeding without it | **Low.** The group list and UoM list **are** supplied and can be seeded. Only the code *format* (prefix, sequence width, check digit) is unknown. |
| What I need | The item-code format. |
| Status | `PARTIALLY INFERABLE` — groups and UoM supplied; code format unknown |

---

## ES-020 · Store Requisition / Issuance slip layout

| Field | Value |
|---|---|
| Referenced at | ZAM/ZD Issuance Process — "Issuance may only happen **against PR form**"; "**Issuance Slip** must be signed by Receiver (User Department)" |
| What depends on it | The printed issuance slip and its signature block. |
| What the system does now | Store issues exist with an approval chain; no slip, no receiver signature. |
| Risk of proceeding without it | **Low.** The signature mechanism is buildable through the attestation engine; only the printed layout is unknown, and a reasonable layout can be derived from the other annexures' house style. |
| What I need | The slip layout, if a prescribed one exists. |
| Status | `NOT SUPPLIED` — low impact |

---

## ES-021 · Repair & Maintenance department process

| Field | Value |
|---|---|
| Referenced at | ZAM/ZD Store Keeping table — employee return, "Fails inspection; sent to the **Repair and Maintenance Dept.**" |
| What depends on it | The handoff at the end of the employee-return flow. |
| What the system does now | Assets carry an `UNDER_REPAIR` status. No R&M handoff, no return-from-repair. |
| Risk of proceeding without it | **Low.** The handoff can be modelled as a status transition with an owner; the R&M department's own process is out of scope. |
| What I need | Whether R&M tracking is in scope for this system. |
| Status | `NOT SUPPLIED` — low impact |

---

## ES-022 · Bidding and tender thresholds for disposal

| Field | Value |
|---|---|
| Referenced at | ZAM Scrap table — "**Depending upon volume**, quotes will be required & assessed afterwards"; "In case of **insignificant value/quantum** after consulting with relevant/concerned business head" |
| What depends on it | When disposal requires competitive bidding versus a business-head consultation. |
| What the system does now | Two configurable thresholds — `disposal.bidding_required_above` and `disposal.management_approval_above` — both invented values. |
| Risk of proceeding without it | **Medium.** "Depending upon volume" and "insignificant value" are not rules. The current thresholds have no source authority. |
| What I need | The value or volume bands. |
| Status | `NOT SUPPLIED` |

---

## ES-023 · Emergency procurement authority

| Field | Value |
|---|---|
| Referenced at | ZAM/ZD Price Competitiveness Policy — "For emergency purchases price competitiveness **may not be considered in detail**. (Ref: Head Office 2nd floor renovation …)" |
| What depends on it | Who may declare an emergency, which controls may be waived, and what post-facto review applies. The source gives one worked example and no rule. |
| What the system does now | Nothing. |
| Risk of proceeding without it | **High.** An emergency route without a named approver is a bypass of every sourcing control. The brief requires an explicit workflow; the *authority* for it is undefined. |
| What I need | Who declares an emergency, which controls may be waived, and the review requirement. |
| Status | `NOT SUPPLIED` |

---

## ES-024 · Site visit programme parameters

| Field | Value |
|---|---|
| Referenced at | ZD Annexure B — "Vendor Qualification / **Site Visit** / **5% of total spend of the project** / **Top 25 vendors by spend** / QC will share rejection reports monthly basis / IR's will be shared to SC after duly signed by QS, QC, CM" |
| What depends on it | A vendor site-visit programme scoped by spend, and a monthly QC rejection report. Roles **QS** (Quantity Surveyor), **QC** and **CM** (Construction Manager) appear only here and have no system counterpart. |
| What the system does now | Nothing. |
| Risk of proceeding without it | **Medium.** The 5% and top-25 figures are given, but whether 5% of spend is the visit *trigger*, the *coverage target* or the *cost budget* is not stated. |
| What I need | Clarification of the 5% rule, and confirmation of the QS/QC/CM roles. |
| Status | `PARTIALLY INFERABLE` — figures supplied, meaning ambiguous |

---

## ES-025 · Prohibited role combinations

| Field | Value |
|---|---|
| Referenced at | ZD §2.1.4 ii — "Employees should not hold **conflicting roles** that leave them open to accusations of unethical behaviour" |
| What depends on it | The role-assignment conflict check. The mechanism is built and runs on every role grant (`assertNoRoleConflict`), but its list is empty. |
| What the system does now | Enforces the three **per-transaction** separations the source does state (see `lib/sod.ts`), and accepts any role combination. |
| Risk of proceeding without it | **Low, and deliberately so.** Guessing pairs is the greater risk: 22 roles produce 231 possible pairs, and several combinations that *look* conflicting are how the organisation works today — a head of department legitimately raises requisitions for their own team and legitimately approves that team's requisitions. Blocking that would stop real work on an invented rule. The per-transaction rules already stop the actual abuse, which is one person occupying both sides of one document. |
| What I need | The named role pairs nobody may hold at once, with the reason for each. |
| Status | `NOT SUPPLIED` |

---

## Summary

| Status | Count |
|---|---|
| `NOT SUPPLIED` | 20 |
| `PARTIALLY INFERABLE` | 4 |
| `SUPPLIED` | 1 |
| **Total** | **25** |

### The four that block the most work

1. **ES-001 Financial Authority Limits Policy** — the whole PO and payment approval matrix is currently running on invented thresholds.
2. **ES-006 Vendor Performance Evaluation Form** — the source itself says "Form To Be Attached". Until it arrives, PC-002/003/004 stay open and the performance instrument cannot be built correctly.
3. **ES-008 JEFFI** — an undefined but mandatory artefact in the ZD payment chain.
4. **ES-018 Sage/SAP system of record** — an architecture decision, not a feature. If Sage is the book of record, a large part of this system is a parallel ledger.

### What this means for the final report

Conclusion **B — Complete organisational procurement compliance — cannot be
claimed** while any `NOT SUPPLIED` row remains. Conclusion **A — compliance
against the two supplied SOP files** — can be pursued to completion for every
requirement that does not depend on a row above.
