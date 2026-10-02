# Synthetic packs B and C — shared story

Synthetic only. No real insurer, person, policy, hospital or phone number. Pack A (the root folder,
Example Family Health Plan) stays unchanged. Packs B and C exist so that every extraction parameter is
proven with a real value in at least one pack, including member-specific variants.

Each section file pair lives in its pack folder: `sNN-wording.txt` (pages separated by a line that is
exactly `=== PAGE BREAK ===`) and `sNN-gold.json` (`{ "section": N, "expected": [ ... ] }`, same item
shape as pack A gold, each item with a verbatim `quote`). Gold must list **every** parameter key of the
section at least once (found true or false).

## Pack B — employer group policy (folder `pack-b/`)

- Insurer: **Demo General Insurance Company Limited**, IRDAI Registration No. **998**.
- Product: **Demo Group Health Shield**, UIN **DEMHLGP26002V012526**, version 2.
- Policyholder (employer, group administrator): **Demo Software Services Private Limited**.
- Master policy number **DG/GHS/2026/004567**; employee certificate number **DG/GHS/2026/004567/0042**.
- Previous policy number **DG/GHS/2025/003311** (renewal of the same group).
- Broker: **Demo Insurance Brokers Private Limited**, broker code **BRK-0077** (intermediary_type broker).
- TPA: **Demo Care TPA Private Limited**, cashless helpline **1800-111-2222**, cashless email
  **cashless@democaretpa.example**. Insurer helpline **1800-333-4444**.
- Documents: master policy schedule, policy wording, certificate of insurance, endorsement schedule
  with **Endorsement No. 1 (addition of Arjun Verma from 2026-06-15)** and
  **Endorsement No. 2 (room rent enhancement for maternity admissions)**.
- Policy period **2026-04-01 to 2027-03-31**. Group first inception **2021-04-01**.
- Insured members (certificate DG/GHS/2026/004567/0042):
  - **Asha Verma** — employee, DOB 1985-03-02, member ID **DG0042-01**, effective 2021-04-01.
  - **Vikram Verma** — spouse, DOB 1983-11-20, member ID **DG0042-02**, effective 2021-04-01,
    declared condition **type 2 diabetes** (protected), premium loading **15%** (protected), underwriting
    outcome **modified_terms**, PED co-pay **10%** on diabetes-related claims (protected).
  - **Kamala Verma** — mother (dependent parent), DOB 1955-07-09, member ID **DG0042-03**, effective
    2024-04-01, pre-policy check-up **done**, permanent exclusion of **chronic kidney disease** (protected).
  - **Arjun Verma** — son, DOB 2026-01-10 (newborn added mid-term), member ID **DG0042-04**, effective
    **2026-06-15** by Endorsement No. 1.
- Sum insured: **individual_per_member ₹5,00,000** per member; parents capped at **₹3,00,000** each;
  corporate buffer **₹25,00,000** for the whole group (employer approval needed).
- Maternity: covered for **Asha Verma** only (member-scoped), max **2 deliveries**, limit **₹60,000 normal
  / ₹80,000 C-section**; no maternity waiting period for group (day-one cover).
- Waiting periods **waived** for employees and spouses from day one; **dependent parents** have a PED wait of
  **12 months** (member-scoped variant); waiting-period buy-down: none for group but continuity credit for
  employees joining from a prior group policy. Specified-disease wait variation: **waived for employees,
  12 months for parents**. Relapse within **45 days** of discharge is treated as the same illness.
- Money: room rent **₹5,000 per day** fixed (`fixed_amount_per_day`); ICU **2% of sum insured per day,
  maximum ₹10,000 per day**; **general co-pay 10% on every claim of dependent parents** (state it as a
  co-pay clause; gold item for `copay_general_percent` uses memberScope "Kamala Verma"); **non-network
  co-pay 20%** for all members; voluntary deductible option exists (`deductible_kind` = voluntary) but no
  amount was opted (`deductible_amount` found: false).
  Joint replacement limit **₹1,50,000 per joint**; air ambulance **₹2,50,000 per hospitalisation**;
  AYUSH **fixed ₹25,000 per policy year**; domiciliary **10% of sum insured up to ₹50,000**;
  organ donor **₹1,00,000**; hospital daily cash **₹1,000 per day for up to 10 days**; attendant allowance
  **₹500 per day**; other disease sub-limits (**cardiac procedures ₹2,00,000; cancer as per actuals**);
  surgery component caps (**surgeon and anaesthetist fees together up to 40% of the surgery package**);
  package rate rule (**network package rates apply for listed procedures**); reducer order
  (**sub-limits first, then co-pay, then deductible**); guaranteed bonus **5% per year**; inflation
  protection **not offered** (absent in B; proven in C).
- Treatment add-ons proven in B: bariatric (BMI ≥ 40 or ≥ 35 with comorbidity), rehabilitation, chronic
  care programme, wellness programme, vaccination (anti-rabies post-bite), second opinion, critical illness
  lump sum benefit (cancer, heart attack, stroke), hospital daily cash, treatment abroad (only for listed
  critical illnesses, pre-approved, up to the sum insured, excluding USA/Canada).
- Exclusions proven in B: permanent exclusion for Kamala Verma (member-scoped, protected), self-harm.
- Hospital access proven in B: non-network cashless allowed with **48 hours** notice; preferred provider
  network (lower co-pay); authorisation delay consequence (insurer pays interest if discharge
  authorisation exceeds 3 hours).
- Claims proven in B: ombudsman limit **₹50,00,000**, complaint within **1 year** (365 days) of the
  insurer's final reply, consumer forum named.
- Renewal proven in B: group-to-individual conversion within **30 days** of leaving employment, premium
  discounts (online purchase 5%, long-term 7.5%), short-period cancellation scale (table), multi-year
  discount **7.5%** for 2-year terms (this belongs to the individual conversion product).

## Pack C — super top-up (folder `pack-c/`)

Only sections 1, 3 and 6 are needed. Insurer **Demo General Insurance Company Limited**, product **Demo
Super Top-Up**, policy **DG/STU/2026/000789**, type **super_top_up**, sum insured **₹20,00,000**,
policy period 2026-04-01 to 2027-03-31. Proves: `topup_deductible_kind` = aggregate_per_year,
`topup_deductible_amount` = ₹5,00,000, `base_payout_counts_toward_deductible` = true (amounts paid by any
other indemnity policy count toward the deductible), `inflation_protection_percent` = 10% per year,
`deductible_kind` = mandatory, `deductible_amount` = ₹5,00,000, `icu_limit_amount` / `icu_limit_percent`
may also be proven here if convenient. Every other key of these sections answers found: false unless the
wording states it.
