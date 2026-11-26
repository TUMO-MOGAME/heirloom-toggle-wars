# Heirloom: research, evidence and honest limits

> Written 25 November 2026 for the Dev3pack "Best App Overall on Solana" judges. It backs up the problem, the legal
> picture, the competition, our weaknesses and the plan to test the idea with real people.
>
> **Rules for this file.** Every number links to the page we read, with the page's date. "Primary" means a
> government body, a regulator, a statute, a court or a peer-reviewed study. "Secondary" means news or a company blog.
> **[unverified]** means we could not open or confirm the source ourselves. We have run **no user interviews yet**, so
> this file contains no user results, quotes or survey numbers.

## 1. Summary for judges

- **The problem is real and measured.** About **150,000** deceased estates are registered with the Master each year
  ([Parliamentary reply NW4249, Aug 2026](https://pmg.org.za/committee-question/39970/), primary). Practitioners
  report letters of executorship taking **six weeks or more**, against a 21-working-day target, and wind-ups of
  **two to five years** ([Daily Maverick, 18 Aug 2025](https://www.dailymaverick.co.za/article/2025-08-18-master-of-high-court-digitisation-shows-promise-but-hurdles-remain), secondary).
- **The state already holds money for children, and that system is under strain.** The Guardian's Fund owed
  beneficiaries (minors, missing heirs and others) **R19.135 billion** at 31 March 2026, and lost **R13.5 million**
  to fraudulent bank-detail changes in September 2025 ([Guardian's Fund Annual Report 2025/26](https://static.pmg.org.za/Annual_Report_Guardians_fund_2026.pdf), primary).
- **The biggest open risk is not the code, it is the money rail.** The SARB says it is "unlikely to consider foreign
  currency-pegged stablecoins as payment instruments for domestic transactions"
  ([SARB/FSCA Joint Communication, May 2026](https://www.resbank.co.za/content/dam/sarb/what-we-do/payments-and-settlements/regulation-oversight-and-supervision/designation-notices/280526%20Joint%20Communication_Crypto%20assets%20for%20domestic%20payment%20purposes.pdf), primary).
  So schools must be paid in rand through a licensed partner. Heirloom simulates that step today.
- **Heirloom is not a will and cannot be one.** It has to sit next to a paper will, ideally inside a trust run by a
  licensed trustee. That needs a legal opinion we do not have yet (§3).
- **No user validation yet.** The interview kit exists ([`validation.md`](validation.md)); results are empty (§7).

## 2. Problem evidence

### 2.1 Sources in `business.md` §1, re-checked on 25 Nov 2026

| Claim in business.md | What we found on the page | Status |
|---|---|---|
| 66% of South Africans have no will | Confirmed: "66% of South Africans do not have wills", Sanlam Legacy Wills Survey. No sample size given ([TimesLIVE, 19 Sep 2025](https://www.timeslive.co.za/news/south-africa/2025-09-19-66-of-south-africans-risk-family-feuds-by-dying-without-wills-sanlam-survey/)) | OK, secondary. Say "a Sanlam survey found" |
| 70–75% die without a valid will | The page says 70–75% of **working South Africans** lack a valid will, attributed to the Master, with no date for the Master's figure ([Discovery, Feb 2021](https://www.discovery.co.za/corporate/the-importance-of-a-last-will-and-testament)) | **Wrong as worded.** It is about living workers, not deaths. Reword or drop |
| 474,366 registered deaths in 2024 | Confirmed, Stats SA "Mortality and causes of death" ([TimesLIVE, 29 Sep 2026](https://www.timeslive.co.za/news/south-africa/2026-09-29-tuberculosis-leads-male-deaths-diabetes-tops-among-women/)) | OK, secondary report of a primary source |
| About 170,000 estates a year | Page returned HTTP 403; could not read it ([Magzter](https://www.magzter.com/en/stories/newspaper/The-Citizen/MASTERS-OFFICE-CLEANUP-SLOW)) | **Failed.** Replace with the Master's own figure: **about 150,000 a year** ([NW4249](https://pmg.org.za/committee-question/39970/)) |
| Simple estate 6–9 months, now about double; Home Affairs and SARS up to 6 months each | Confirmed ([The Citizen, 2 Dec 2024](https://www.citizen.co.za/business/winding-up-of-estates-in-sa-in-shambles)) | OK, secondary |
| "Eight months is quick, three years is not unusual" | Confirmed ([Daily Maverick, 28 Oct 2025](https://www.dailymaverick.co.za/article/2025-10-28-frozen-estates-plan-for-the-everyday-while-it-your-affairs-are-wound-up)) | OK, secondary (opinion column) |
| Executor fee up to 3.5% + VAT, plus 6% of income | Confirmed ([Capital Legacy, 23 Jul 2023](https://www.capitallegacy.co.za/article/81/executor-fees-and-duties-explained); [legalwills.co.za, 15 Jan 2026](https://www.legalwills.co.za/blog/2026/01/15/executor-fees/): about 4.025% with VAT) | OK, secondary |
| 2.8m orphans in 2022 (14% of children); 64% lost their father | Confirmed via news on the UCT Child Gauge 2024. Precisely: 64% of orphans are **paternal-only** orphans ([Cape Times, Aug 2024](https://capetimes.co.za/news/2024-08-22-mens-high-mortality-rate-leaves-many-children-orphaned)) | OK, secondary. Add the primary Census figures below |
| NSFAS "missing middle": 12,000 loan applications vs 893,847 bursary applications | Confirmed, including R350k–R600k band and the 68,446 estimate ([Business Day, 6 Jan 2026](https://www.businessday.co.za/news/education/2026-01-06-government-receives-lacklustre-response-to-offer-of-student-loans-to-the-missing-middle/)) | OK, secondary |
| Stellenbosch withheld 1,429 degrees | Confirmed, as of 31 Dec 2025; student debt over R1.1bn ([TimesLIVE, 30 Apr 2026](https://www.timeslive.co.za/news/south-africa/2026-04-30-stellenbosch-university-withholds-1429-degrees-as-student-debt-surpasses-r11bn/)) | OK, one university only |
| Master's living-expenses letter (GoLegal) | Page returned HTTP 403 ([GoLegal](https://www.golegal.co.za/frozen-assets-death/)) | **[unverified]**. Find another source before quoting |

`business.md` §3 sources also re-checked: SARB stablecoin volumes (under R4bn in 2022 to nearly R80bn by Oct 2025;
7.8m users at Luno, VALR, Ovex, July 2025) ([FXStreet, 26 Nov 2025](https://www.fxstreet.com/cryptocurrencies/news/south-african-reserve-bank-flags-crypto-risks-as-users-reach-78-million-202511261025)),
FSCA 310 of 533 CASP licences by 31 Mar 2026 ([FAnews, 15 Apr 2026](https://www.fanews.co.za/article/compliance-regulatory/2/financial-sector-conduct-authority-fsca-was-fsb/1059/update-on-licensing-and-supervision-of-crypto-asset-service-providers/43764)),
CARF from 1 Mar 2026 ([SARS, 6 Mar 2026](https://www.sars.gov.za/latest-news/the-carf-takes-effect-bringing-transparency-to-crypto-asset-reporting/)),
PayShap 461m transactions worth about R403bn ([TechCentral, 2 Dec 2025](https://techcentral.co.za/high-fees-keep-payshap-stuck-in-first-gear/275073/))
and Chainalysis $205bn for Sub-Saharan Africa ([Chainalysis, 10 Sep 2025](https://www.chainalysis.com/blog/subsaharan-africa-crypto-adoption-2025/)) all
match. One nuance: the same Chainalysis post says **bitcoin was 74% of fiat-to-crypto purchases in South Africa**, so
"stablecoins replaced bitcoin" holds for exchange trading pairs (SARB), not for what people buy with rand.

### 2.2 Stronger evidence we added

**The Master's Office (primary unless marked)**

| Fact | Number | Source |
|---|---|---|
| Deceased estates registered a year | **About 150,000** | [NW4249, question dated 20 Aug 2026](https://pmg.org.za/committee-question/39970/) |
| Online registration uptake | About 57,300 estates registered online since April 2023; about 16,500 in the first seven months of 2026, **about 18%** of that year's estates | Same reply |
| Backlog size | Not published. The Department "monitors deceased estate backlogs"; its turnaround strategy is still "being finalised" | [NW4411, 10 Nov 2026](https://pmg.org.za/committee-question/41776/) |
| Online system scope | Launched 10 Oct 2023 at five offices (Johannesburg, Durban, Cape Town, Pretoria, Thohoyandou) | [DOJ, Deceased estates](https://justice.gov.za/master/deceased.html) |
| Real turnaround | Letters of executorship "six weeks or more" vs a 21-working-day target; families wait "two to five years" | [Daily Maverick, 18 Aug 2025](https://www.dailymaverick.co.za/article/2025-08-18-master-of-high-court-digitisation-shows-promise-but-hurdles-remain) (secondary) |
| Office-level failure | Mbombela: "months, and in some cases years"; staff count disputed (45 vs about 15) | [Daily Maverick/GroundUp, 24 Feb 2026](https://www.dailymaverick.co.za/article/2026-02-24-this-might-be-the-worst-masters-office-in-the-country/) (secondary) |

**The Guardian's Fund: money the state already holds for children**

The Fund holds money paid to the Master for minors, unborn heirs, missing and untraceable beneficiaries, including a
minor's inheritance paid in by an executor. From its 2025/26 annual report
([PMG copy](https://static.pmg.org.za/Annual_Report_Guardians_fund_2026.pdf), primary, year to 31 Mar 2026):

| Fact | Number |
|---|---|
| Owed to beneficiaries (capital and interest) | **R19.135 billion** (R18.800bn a year earlier) |
| Total assets | R23.146 billion |
| Paid out to beneficiaries in the year | R2.599 billion, across 34,833 payment transactions |
| Interest rate credited to beneficiaries | Fell from 8.4% (2024/25) to 7.6% (2025/26) |
| Fraud loss | **R13,485,193.03**, from fraudulent changes to beneficiary bank details in Sept 2025 (Pietermaritzburg, Makhanda) |
| Systems | New payment system piloted in Kimberley from April 2025; national rollout halted in Nov 2025 over data-migration integrity |
| Unclaimed after 30 years | R10.162 million at year end, forfeited to the state under s92 of the Administration of Estates Act |

Why it matters: when a parent leaves a lump sum to a minor without a trust, it can end up here, paid out by a
paper-and-bank process that the Department itself says "has not delivered the level of control originally intended".
We found **no figure for "unclaimed billions"**; the large number is money owed, not money lost.

**Orphans and schooling**

| Fact | Number | Source |
|---|---|---|
| Orphan rates, Census 2022 (ages 0–17) | Paternal 8.9%, maternal 2.3%, double 2.5% (all down since 2011) | [SAnews on Stats SA Census 2022, 13 Oct 2023](https://sanews.gov.za/node/65875) (government news service) |
| Effect of parental death on school | "The loss of a child's mother is a strong predictor of poor schooling outcomes." A father's death is linked to household poverty, but "has no significant effect on subsequent household economic status" | [Case & Ardington, SALDRU WP 97, 2004](https://econpapers.repec.org/paper/ldrcssrwp/097.htm); published in *Demography* 43(3), 2006 ([RePEc](https://econpapers.repec.org/RePEc:spr:demogr:v:43:y:2006:i:3:p:401-420)), peer-reviewed. KwaZulu-Natal data |

**This evidence cuts against part of our story.** The best SA study finds the mother's death, not the loss of money,
drives worse schooling. Heirloom helps with money and administration; it does not replace care. We should not claim
it prevents dropout until a pilot measures it.

**Fees and fee inflation**

| Fact | Number | Source |
|---|---|---|
| School fees, 2026 | Education tuition overall **+5.4%**; primary and secondary **+6.2%**; private secondary **+7.5%**; headline CPI 3.1% | [BusinessTech on Stats SA CPI, 22 Apr 2026](https://businesstech.co.za/news/finance/858016/major-pain-for-parents-in-south-africa/) (secondary; Stats SA blocks automated reads) |
| University fees, 2026 | Tertiary **+4.2%** (3.7% in 2025) | Same |
| First-year tuition, 2026 | BCom about **R60k–R111k** a year (UCT R62,340–R110,580; Wits R62,830–R85,260; UP R60k–R72k; SU R59,856), before books and housing | [BusinessTech, 17 May 2026](https://businesstech.co.za/news/?p=859648) (secondary, from university estimates) |
| DHET 2026 fee guidance | A 4.15% cap was reported | News24, 29 Jan 2026 **[unverified: page returned 403]** |

**Trusts: the existing tool, and why small families skip it**

| Fact | Number | Source |
|---|---|---|
| Master's fee to register a trust | R250 per trust instrument (since 1 Jan 2018, GN 1162) | [MJK Inc, reviewed 29 Sep 2026](https://mjkinc.co.za/trusts/costs-and-fees) (secondary); fee directive referenced at [DOJ Trusts](https://justice.gov.za/Master/trust.html) |
| Attorney set-up of an inter vivos trust | One firm: **R9,500 + VAT** once-off | [Shepstone & Wylie, 14 Nov 2025](https://www.wylie.co.za/Articles/Read/11497/GET-YOUR-DUCKS-IN-A-ROW-TRUSTS-AND-WILLS) (secondary, one firm's price) |
| Running costs | Independent trustee, annual accounts, two SARS returns, s7C on loans; no amounts given | MJK Inc, above |
| Is it worth it for a small fund? | "the structure may end up costing more than it adds in value" | [Daily Maverick, 19 Mar 2026](https://www.dailymaverick.co.za/article/2026-03-19-should-you-set-up-a-trust-for-your-childs-education-in-south-africa.md) (opinion) |
| Compliance load | Beneficial-ownership register filed with the Master since 1 Apr 2023; no trustee may act without letters of authority | [DOJ Trusts](https://justice.gov.za/Master/trust.html) |

**Crypto and stablecoins in South Africa**

| Fact | Number | Source |
|---|---|---|
| Users | About 7.8 million on crypto platforms, H1 2025 (Discovery Bank report) | [Semafor, 6 May 2026](https://www.semafor.com/article/05/06/2026/nearly-8-million-south-africans-use-crypto-report) (secondary) |
| Stablecoins as payment | Crypto, stablecoins included, is "not legal tender" and outside the National Payment System Act; the SARB is "unlikely to consider foreign currency-pegged stablecoins as payment instruments for domestic transactions"; it wants to test **rand-pegged** stablecoins in the IFWG sandbox | [SARB/FSCA Joint Communication, May 2026](https://www.resbank.co.za/content/dam/sarb/what-we-do/payments-and-settlements/regulation-oversight-and-supervision/designation-notices/280526%20Joint%20Communication_Crypto%20assets%20for%20domestic%20payment%20purposes.pdf) (primary) |
| Who needs a licence | Anyone giving advice on, or acting as an intermediary for, crypto must be an FSCA-licensed FSP; purely decentralised peer-to-peer use needs no FSP | Same |

## 3. Legal reality

### 3.1 Can an on-chain plan be a will? No.

- **Wills Act 7 of 1953, s2(1)(a):** a will must be signed at the end by the testator in the presence of two
  competent witnesses who are present at the same time and also sign (with further rules for multi-page wills).
  Courts read these formalities strictly to prevent fraud ([Mahlaela & Monyamane, PER/PELJ 2024(27)](https://scielo.org.za/pdf/pelj/v27n1/51.pdf), peer-reviewed).
- **ECTA 25 of 2002 shuts the electronic route.** Under s4(3) and Schedule 1, ECTA's sections on writing and
  signatures do not apply to the Wills Act; under s4(4) and Schedule 2, ECTA must not be read as "giving validity" to
  a will (same article, quoting the Act). So an electronic or wallet signature does not make a valid will.
- **The only door is s2(3) condonation, after death, by a court.** A High Court may order the Master to accept a
  document that fails the formalities if it is satisfied the deceased meant it as their will. Requirements: the
  deceased drafted or executed it personally, has died, and had the intention (*animus testandi*). The SCA took the
  strict view in *Bekker v Naudé* 2003 (5) SA 173 (SCA) (same article).
- **Recent cases.** The Kimberley High Court ordered the Master to accept an **electronically signed** 2021 document as
  the late Justice Yvonne Mokgoro's will (order 1 Aug 2025) and refused leave to appeal, holding that ECTA does not
  exclude s2(3) ([Moonstone, 12 Mar 2026](https://www.moonstone.co.za/judge-upholds-decision-over-electronically-signed-will/), secondary).
  In *Perumal v Janse van Rensburg NO* [2025] ZAGPPHC 145 the Gauteng court condoned a printed copy of an electronic
  document; a *South African Law Journal* note (Faber, SALJ 142(4)) criticises the reasoning
  ([Juta](https://www.jutajournals.co.za/perumal-v-janse-van-rensburg-condonation-of-an-electronic-document-under-section-23-of-the-wills-act-one-step-forward-two-steps-back)).
- **Reform.** We found **no South African reform bill or SALRC project** on electronic wills in 2024–2026. The 2024
  PER article *proposes* amending both Acts. England and Wales' Law Commission recommended e-wills in May 2025; that
  is not SA law.

**What this means for Heirloom:** condonation is a costly, after-death court case. A product cannot rely on it.
Heirloom must never call itself a will. That is already our position (`business.md` §9).

### 3.2 Structures that could work (all need a legal opinion)

| Structure | How Heirloom fits | Main legal question |
|---|---|---|
| **Inter vivos trust** with a licensed trustee | The trust owns the vault; the rules are the trust's administration rules; the trustee is a verifier | Can a trustee lawfully hold USD₮ in self-custody and delegate payout checks to a program? Trustees need Master's letters of authority and must keep a BO register ([DOJ](https://justice.gov.za/Master/trust.html)) |
| **Testamentary trust** named in the paper will | The will names the trust and trustee; Heirloom runs the rules after the trustee is appointed | Money in the vault before death is still the parent's estate, so it may freeze with everything else |
| **Living plan as gifts while alive** | Payments to institutions during life are ordinary spending or donations | Donations tax and s7C; what happens to the balance at death is still estate property **[needs counsel]** |
| **Insurer or fund with nominated beneficiaries** | A licensed insurer owns the product; Heirloom is the payout engine | Requires an insurer partner; heavy regulation |

Our current reading: the first realistic shape is an **inter vivos trust administered by a licensed fiduciary, with
Heirloom as its payout tool**, and rand payouts through an FSCA-licensed CASP. This is a hypothesis, not advice.

## 4. Competitors

Prices and features are from each company's own page unless marked.

### 4.1 South African estate, trust, insurance and savings providers

| Provider | What it offers | Price (as found) | Gap Heirloom aims at |
|---|---|---|---|
| Capital Legacy | Free online wills; Legacy Protection Plan (underwritten by Guardrisk) covers the "costs of dying"; claims 1.6m+ wills drafted | Example: R208.50/month to cover R428,246 of costs on a R2m estate ([capitallegacy.co.za](https://www.capitallegacy.co.za/)) | Pays estate costs, not purpose-locked fees; still waits on the paper estate |
| Sanlam Legacy Plan / Sanlam Trust | Cover for estate duty and executor fees; trusts | No price on the page ([Sanlam](https://www.sanlamonline.co.za/financialplanning/wills-trusts-estates/sanlam-legacy-plan)) **[price unverified]** | Same |
| Old Mutual Wills and Trusts | Free will; you appoint Old Mutual as executor (brochure, via search) | Fee schedule not found **[unverified]**; site would not load (header error) | Executor tariff still applies |
| Banks (Absa, FNB, Standard Bank, Nedbank) | Wills, executor and trust services | Nedbank publishes a wills fee schedule (2021) **[not read]**; the statutory cap is 3.5% + VAT | The bank account itself freezes at death |
| Discovery Global Education Protector | Insurance: an annual lump sum when you claim, for fees and costs, "subject to limits set by Discovery"; university tuition benefit for Vitality members | Quote only ([Discovery](https://www.discovery.co.za/life-insurance/education-protector)) | Closest rival on purpose. It pays the policyholder, not the school, and only if you buy cover while insurable |
| Funeral cover (Old Mutual, burial societies) | Fast cash for the funeral | Old Mutual advertises from about R24–R28/month for young members **[search snippet only; page did not load]** | Covers the funeral, not years of fees |
| Education savings (unit trusts, endowments, tax-free savings) | Saving for fees | Varies; not verified | Owned by the parent, so frozen in the estate; a lump sum to a minor may go to the Guardian's Fund |

### 4.2 Crypto inheritance

| Product | What it does | Price | Gap |
|---|---|---|---|
| Casa | Multi-key vault "with inheritance built in" | Standard $250/yr; Premium $2,100/yr ([casa.io](https://casa.io/gold)) | Hands the heir the keys; no purpose rules |
| Vault12 | Guardian-based backup; "Digital Inheritance" to a designated person | Inheritance plan 29.99/month ([vault12.com](https://vault12.com/pricing/)) | Same |
| Kresus | Name a beneficiary; access after an inactivity period and a "verified succession event" | $99.99/yr ([KuCoin news, 9 Jul 2026](https://www.kucoin.com/news/flash/kresus-launches-99-99-year-inheritance-service-for-self-custody-wallets), secondary) | Same |
| Sarcophagus | Dead man's switch for encrypted files (Ethereum + Arweave; reportedly now on Base) | Token-based **[unverified]** | Files, not money rules |
| Inheriti (Safe Haven) | Decentralised inheritance and backup plans; paid in SHA token | **[price unverified]** | Same |

### 4.3 Solana-native

| Project | What it does (from its own page) | Gap |
|---|---|---|
| Streamflow | Token vesting, payment streams, payroll-like streams, escrow, milestone releases ([streamflow.finance](https://streamflow.finance/)) | No death trigger, no payee whitelist by purpose, no human quorum |
| Squads | Multisig and "programmable smart accounts" for Solana teams ([squads.xyz](https://squads.xyz/)); spending limits and time locks **[unverified on its pages]** | A safe for organisations; no inheritance logic |
| Zebec | Real-time stablecoin payroll, cards, "20+ chains" ([zebec.io](https://zebec.io/)) | Payroll, not inheritance |
| SolWill | Dead man's switch: deposit SOL, check in, up to 10 beneficiaries claim shares after timeout plus grace ([solwill.pages.dev](https://solwill.pages.dev/)) | Inactivity only; whole balance to people; no fraud quorum |
| Eternal Key | Open-source dead man's switch: deposit, check-in, claim, cancel; Superteam grant ([GitHub](https://github.com/retrogtx/eternal-key)) | Same |
| Heres Protocol | Solana inheritance "Intent Capsules" with an inactivity period, encrypted messages, private rollup, CCIP to EVM ([Chainlink hackathon page](https://chain.link/hack-26/projects/heres-protocol)) | Same trigger model; no purpose or institution rules |
| Last Safe | Solana heartbeat plus Lit Protocol (per search result) | **[unverified: Devpost returned 403]** |

We searched Colosseum winner announcements (Radar, Breakout) and found no inheritance or estate project among
the winners. This search was not exhaustive.

## 5. What makes Heirloom different

Only features the README shows working on devnet or in the labelled demo.

| | Heirloom | Dead-man switches (SolWill, Heres) | Casa / Vault12 / Kresus | Streamflow / Squads | SA trust or insurer |
|---|---|---|---|---|---|
| Payouts locked to a purpose and an approved payee (school, university) | **Yes**, program-enforced payee kind, per-claim, yearly and lifetime caps, end date | No | No | Partly (streams to any wallet) | Trust deed can; manual |
| Works while the owner is alive (living plan) | **Yes** (`starts_now` rules, scheduled payments) | No | No | Yes, but no after-death phase | Trust yes; insurance no |
| Death needs people, not just silence | **Yes**: AI review + quorum of trusted people incl. executor + waiting period + owner veto | No (inactivity) | Kresus: "verified succession event" | No | Yes (Master, courts) |
| AI that can only recommend, and refers when unsure | **Yes**, on-chain Refer, then two trusted people or the owner decide | No | No | No | No |
| Asset sale at or above a floor, atomic swap of USD₮ and title NFT | **Yes** (digital title only, not a legal eNaTIS transfer) | No | No | No | Executor sells manually |
| South African rails | Rand display at live VALR price; **rand payout simulated** | No | No | No | **Yes, real** |

Honest reading: the combination is new; each part exists elsewhere. The SA incumbents win on the thing that matters
most to a family, a real rand payment under a legal structure. Heirloom does not have that yet.

## 6. What we are doing wrong, and how to fix it

| Weakness | Why it matters | Fix |
|---|---|---|
| **No user validation.** Zero interviews | We do not know if parents want this, trust crypto for it, or would pay R99/month | Run the `validation.md` interviews before more features; publish results, good or bad |
| **Institutions cannot take USD₮,** and the SARB signals it will not accept dollar stablecoins for domestic payments | The core promise "paid to the school" depends on a rand off-ramp we do not have | Sign a licensed CASP off-ramp (USD₮ to rand by EFT/PayShap, student number as reference). Watch the SARB's rand-stablecoin sandbox |
| **Legal status unclear.** Not a will; may be estate property and freeze anyway | The vault could be frozen with the estate, defeating the purpose | Legal opinion on the trust structure; partner with a licensed trustee; draft will clause reviewed by an attorney |
| **Solo builder** | Bus factor of one, on a product about continuity | Recruit a co-founder with estate-law or fiduciary experience; document runbooks |
| **Scope sprawl.** 58 instructions; voice cloning, letters, guardians, fallbacks, disputes, asset sales, P2P sends, QVAC, Android | More attack surface and less depth on the core | Freeze features; pilot only: plan, vault, claim to institution, death quorum. Park voice and asset sale |
| **Not audited by a firm** (internal audit: [security-audit.md](security-audit.md), 348 tests) | Real money needs an external audit | Audit the core instructions before mainnet; small caps in the pilot |
| **Devnet test mint;** institutions are wallets we control; waits shortened | Nothing proves it works with real money and real schools | Mainnet with real USD₮ and capped amounts, with one real institution in the pilot |
| **Story vs evidence on schooling** | Research shows the mother's death drives worse schooling more than money | Position as "fees keep flowing", not "prevents dropout"; measure in the pilot |
| **Key loss and digital literacy** | Self-custody with a PIN may not suit grieving families | Verifier-quorum recovery (planned P1); partner-held KYC; test with non-crypto users |
| **Off-chain data in server memory** on the hosted sites | Names and reports can be lost on restart | Connect Supabase (schema exists) before any pilot |
| **Pricing untested** | R99/month and 1% fee are assumptions (`business.md` §6) | Ask in interviews; test B2B2C with a funeral insurer or burial society |

## 7. Testing with users

The full kit is in [`validation.md`](validation.md). Summary:

- **Who:** at least 10 people: target 15 survey answers and 5 interviews (3 parents, 1 young adult who lost a
  parent, 1 executor, attorney or fiduciary).
- **Interviews:** 10–15 minutes, 10 questions per group. Ask about the past first; show the idea only at question 8.
  Get consent before notes or quotes; no ID or account numbers.
- **Survey:** 5 questions: role; expected time before estate money pays fees; top two worries; would you use it (1–5);
  what would you pay.
- **Usability (to add):** 3–5 people complete the devnet "three minutes" path in the README (create wallet, plan,
  fund, claim, approve) while thinking aloud. Measure completion and where they get stuck.

**Success thresholds in `validation.md`:** at least 60% answer 4 or 5 on "would use"; at least 30% would pay R50 a
month or more. The pilot in `business.md` §12 adds: 8 of 10 families would pay R99/month; 3 executors want to continue;
1 partner letter of intent; first payout under 7 days after a death claim; 0 payouts outside the rules.

**Proposed decision rules (new, not yet in `validation.md`):**

| If we see | We will |
|---|---|
| Under 40% would use it | Stop the after-death product; test the living plan (allowances and fees) alone |
| Most say "free with funeral cover" | Go B2B2C first (insurer or burial-society rider), not R99/month B2C |
| Parents trust an attorney or bank, not an app | Lead with the fiduciary partner; Heirloom becomes their back office |
| Executors say the vault is estate property and would freeze | Do not launch outside a trust; get the legal opinion first |
| Users cannot finish the devnet path without help | Fix onboarding before any pilot |

### Results (to be filled)

No interviews or surveys have been run as of 25 Nov 2026. Do not fill this table with estimates.

| Metric | Result | Target |
|---|---|---|
| Interviews done (parents / young adults / executors) | _to be filled_ | 5 (3 / 1 / 1) |
| Survey responses | _to be filled_ | ≥ 10 (aim 15) |
| % expecting fees to take > 6 months, or unsure | _to be filled_ | none |
| Top worry | _to be filled_ | none |
| % answering 4–5 on "would use" | _to be filled_ | ≥ 60% |
| % willing to pay ≥ R50/month | _to be filled_ | ≥ 30% |
| % "free with funeral cover" | _to be filled_ | tells B2B2C vs B2C |
| Usability: finished devnet path unaided | _to be filled_ | ≥ 3 of 5 |
| Decision taken | _to be filled_ | none |

## 8. Future: a grounded roadmap

Updated from `business.md` §11. The November 2026 "10+ interviews" milestone was missed and moves to the top.

| When | Milestone | Done when |
|---|---|---|
| Dec 2026 | **Validation first:** 5 interviews, 15 surveys, 5 usability tests; fill §7 | Results table filled; a written go / change / stop decision |
| Dec 2026 – Feb 2027 | **Legal opinion** on trust structure, estate-property risk and FSCA position; privacy policy and POPIA set-up | Signed opinion; will clause reviewed by an attorney |
| Jan – Mar 2027 | **Off-ramp partner:** one FSCA-licensed CASP paying rand to institutions (candidates: Luno, VALR, Stables; targets, not partners) | One real rand payment to a real school or university account in a test |
| Jan – Mar 2027 | **Cut scope** to the core; connect Supabase; recovery via verifier quorum | Pilot build frozen |
| Mar – Jun 2027 | **External audit** of the core instructions | Report published; findings fixed |
| Apr – Jul 2027 | **Pilot:** 20 families, 5 executors, 3 institutions, with a licensed trustee; mainnet USD₮ with small caps; simulated deaths | `business.md` §12 measures met or missed, and reported |
| Sep 2027 | Public launch (Wills Month) only if the pilot passes; first burial-society or insurer rider pilot | Signed partner |
| Watch | SARB/IFWG rand-stablecoin sandbox; revised NPS Act; draft cross-border crypto manual | A rand stablecoin could remove the off-ramp step |

## 9. What we could not verify

- An official count of the Master's backlog (the Department says it is still quantifying it).
- The 170,000 estates figure (source blocked); replaced by the Master's 150,000.
- The "living-expenses letter" practice (GoLegal blocked).
- Stats SA pages directly (blocked); fee inflation taken from BusinessTech's report of Stats SA CPI.
- The DHET 4.15% fee guidance (News24 blocked).
- Old Mutual, Sanlam, bank and Inheriti prices; Squads spending limits; Last Safe details.
- Any peer-reviewed study on university dropout after a parent's death in SA; we found only school enrolment work.
