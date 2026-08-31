# Policy Conflict Register — Zameen Media

Re-scoped from the 28-entry register in `docs/procurement-os-policy-conflicts.md`,
which treated ZAM and ZD as equal sources. With **Zameen Media** as the entity in
scope and `ZD/PRO/SOP-01` as reference only, most of what looked like a conflict
is not one: where each document was explicit for its own entity, the Zameen Media
reading simply applies.

What remains are the conflicts **inside ZAM/PUR/SOP-01** — six places where its
narrative text disagrees with its own annexure image — plus the places where an
approved meeting requirement says something different from the SOP.

## Summary

| Class | Count | Meaning |
|---|---|---|
| Conflict within ZAM/PUR/SOP-01 | 8 | Text disagrees with its own annexure or ToR. **Real, open.** |
| SOP vs meeting requirement | 3 | Source 2 supplements or overrides. Recorded in `business-decisions.md`. |
| Resolved by scope | 6 | Looked like a conflict only because one global value served two entities. |
| Pulled into scope by meeting requirements | 2 | ZD-described, but Source 2 requires them for Zameen Media. **Action needed.** |
| Future / ZD only | 2 | No ZAM or meeting basis. |
| Resolved in build | 7 | Fixed; retained for the audit trail. |

---

## Pulled into Zameen Media scope by the meeting requirements

These two matter most, because the current build has them **switched off for
Zameen Media** on the grounds that only the ZD SOP described them. Meeting
requirement 20 asks for both, which makes them Zameen Media requirements through
Source 2.

### PCZ-01 · Vendor pre-qualification expiry after two years

| | |
|---|---|
| ZAM/PUR/SOP-01 §5.1 | Describes pre-qualification with **no validity period** |
| ZD/PRO/SOP-01 §2.3.1 iii | "Pre-qualification of vendor shall be valid for a period of two (2) years" |
| Meeting requirement 20 | "vendor PQ expiry after 2 years", "requalification" |
| Current system | `policy.pq_validity_months` — enforced in `checkVendorEligibility`, seeded **0 for Zameen Media**, meaning the control is inactive |
| Impact | Zameen Media vendors never expire, so no requalification is ever triggered |
| Required change | Set the Zameen Media value to 24 and cite meeting requirement 20 as its authority, not the ZD SOP |
| Decision needed | **No** — the meeting requirement is explicit. Confirm 24 months. |

### PCZ-02 · Temporary blocking, distinct from blacklisting

| | |
|---|---|
| ZAM/PUR/SOP-01 | **No blocking concept.** §5.14 covers blacklisting only |
| ZD/PRO/SOP-01 §2.3.4 iv–vi | Temporary blocking, scoped Company / Division / BU |
| Meeting requirement 20 | "temporary Blocking separate from Blacklisting", "blocking scope Company / Division / BU" |
| Current system | `policy.vendor_blocking_enabled` — **false for Zameen Media**. A single `SUSPENDED` status with no scope, grounds or unblock workflow |
| Impact | Zameen Media has no way to block a vendor short of blacklisting, and the meeting requirement explicitly separates the two |
| Required change | Enable for Zameen Media with the three scopes. The *grounds* come from the meeting requirement, not from ZD §2.3.4 — see below |
| Decision needed | **Yes** — the grounds. ZD lists unsatisfactory rating, no balance confirmation, static balance over a year; no ZAM source states any. |

> Both are scheduled with vendor governance (Phase 4 of the briefed order), not
> switched on now — turning on an expiry control mid-release would retroactively
> expire live vendors. The flags and enforcement already exist; only the Zameen
> Media values change.

---

## Conflicts inside ZAM/PUR/SOP-01

Six of these were found **only by reading the annexure images**; the extracted
text alone does not reveal them.

| ID | Conflict | Text says | Annexure says | Shipped reading | Decision |
|---|---|---|---|---|---|
| PCZ-03 | Vendor performance instrument | 6 criteria, 40/20/20/10/5/5 | `image11.png`: 5 criteria, 40/20/**30**/5/5 | 5-criterion | **BD-006** — meeting requirement names the 6 |
| PCZ-04 | Rating scale | 4 bands, Unsatisfactory = 0 | `image13.png`: 5 bands, Unsatisfactory = 1 | 5-band | **BD-006** |
| PCZ-05 | Quality scoring | By complaint count | `image12.png`: by accepted-quantity %, **80–90% unscored** | Complaint count | **BD-006** |
| PCZ-06 | Internal reference marks | `image10.png`: 3 / 4 / 5, "out of five" | `image20.png` Annexure 6: 1 / 2 / 4, section max 4 | 1 / 2 / 4 | Open |
| PCZ-07 | Pre-qualification maximum | Header: "Min. Qualifying Score: **30/60**" | Section maxima sum to **61** | 61, qualifying 30 | Open |
| PCZ-08 | Committee member types | Committee tables: Permanent, Observer | `image22.PNG` RNC: **Permanent Mandatory**, Permanent, Observer | All three modelled | Open — effect of Mandatory on quorum |
| PCZ-09 | Committee scope | Engagement limit: "Procurement of **Goods** ≥ 500,000" | Mandate: "**Any transaction** including SLA, AMC, Buildouts…" | Mandate reading | **BD-007** |
| PCZ-10 | RNC quorum | "3 permanent members plus the Head of the Committee" | `image22.PNG`: North and South have **3 members in total** | Central 3; North/South **unset** | Open — arithmetically impossible as worded |

`PCZ-06` and `PCZ-07` share a cause: Annexure 6 is the sheet an evaluator fills
in, and its own arithmetic is self-consistent at 1/2/4 within a section maximum
of 4, totalling 61 across seven sections. The narrative and the header do not
agree with it. Both readings are held; the annexure is the shipped one because it
is the instrument in use.

---

## SOP versus meeting requirement

| ID | Subject | Register |
|---|---|---|
| PCZ-11 | Cost Analysis layout, and manual entry | **BD-006** context; meeting requirement 4 adds manual comparison entry, which Annexure 3 does not contemplate |
| PCZ-12 | Applicable tax rate | **BD-005** — the SOP routes computation to KPMG and states no rate; the meeting requires a dropdown |
| PCZ-13 | Asset vs consumable below PKR 15,000 | **BD-002** — the two meeting statements contradict each other |

---

## Resolved by scope

These were only conflicts because one global setting served two entities. With
Zameen Media in scope, the ZAM reading applies and there is nothing to decide.

| Was | Zameen Media value | Authority |
|---|---|---|
| Vendor evaluation frequency: 3 months vs annually | **3 months** | ZAM §5.9. The shipped default was corrected from 12 to 3 — a ZD figure had been left as the fallback ZAM inherits |
| Committee meeting day: Wednesday vs Thursday | **Wednesday** | ZAM CPC |
| Payment flow: Annexure A vs the JEFFI chain | **Annexure A** — two Internal Audit checkpoints, KPMG tax step, cheque collection Tuesday and Friday | ZAM `image14.PNG`. JEFFI is separately required by meeting requirement 34 — see **BD-003** |
| Petty cash route | **HOD → Director Procurement** | ZAM `image15.png` Annexure 2. ZD's extra Sr. Manager step is out of scope |
| Blacklisting grounds | **ZAM's five**: forged documents, consistent quality compromise, invoice/quantity price variance, consistent partial or late delivery, other | ZAM §5.14 |
| Price comparison cadence vs per-PR quotation rule | **Both** — they were never in conflict, only separately unimplemented | ZAM §5.11 and §4.5.1 |

---

## Correction to the previous register

**The unrated-vendor gate had no Zameen Media authority.** The previous PC-018
rested on ZD §2.3.3 ii — "No business shall be transacted with vendors not having
satisfactory performance rating" — which is a ZD clause. ZAM §5.9 says only that
performance is evaluated after selection; it states no sourcing bar.

The shipped behaviour is `UNRATED-ALLOW-WITH-EXCEPTION`, which permits sourcing
and records the gap. That remains a reasonable default and is **not** a ZAM
requirement; it must not harden into a block without a ZAM or meeting basis. The
`UNRATED-BLOCK` variant stays available and stays unselected.

---

## Future / ZD only

| Subject | Why |
|---|---|
| ZD nine-document payment set and single-IA-checkpoint chain | ZAM uses Annexure A. Retained for future expansion |
| ZD's six blacklisting grounds | ZAM has its own five |
