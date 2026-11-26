# The simulator: method (published before any run)

> Fixed on Thu 26 Nov 2026, before the first simulated visitor. Plan §6 sets the visitor types; this page fixes
> everything else. After the first run nothing on this page changes. A bug fix to the simulator itself (a selector,
> a timeout) is allowed and is logged in `status.md` with the run it affects.

**In one sentence (for the README):** the simulation proves that the pipeline works end to end on the live site, not
how people behave; only the Production experiment speaks to that.

## What it is

`scripts/simulate/simulate.ts` drives a real browser (Playwright, Chromium) through the real site. Every simulated
visitor is a **fresh browser context**, so it has empty local storage and the app makes it a fresh anonymous id. The
visitor opens `/try`, lands on the plan builder, and acts according to its type below. The app, Flagsmith and the
events are exactly the ones real visitors get; only the visitor is a script.

- **Where it runs:** the **Simulation** deployment only (the `simulation` branch on Vercel, built with the Simulation
  environment key), or a local dev server for a smoke test. The script refuses the Production host
  (`heirloom-toggle-wars.vercel.app`) and Heirloom's own sites, and needs an explicit `--env sim` or `--env dev`.
- **It reads only the screen.** A visitor decides from what is visible, as a person would: are suggested replies
  shown under the greeting or not. It never reads the flag value, the Flagsmith response, local storage or the
  variant. It does not know which version it is in.
- **Nothing personal.** The messages it types are fixed, made-up text about a fictional family. No name, email or
  wallet is entered. Flagsmith receives only what the app always sends: the anonymous id and the event names.

## Who arrives, and when

- **Arrivals are spread over time.** For a run of N visitors over a duration T, each visitor's arrival time is drawn
  uniformly in [0, T] and the times are sorted (a Poisson arrival process with N arrivals). The plan's run is
  2,000 visitors over the hackathon day (about 1,000 per version), so Flagsmith shows enrolment over hours, not one
  spike. A concurrency cap (default 4 browsers at once) can delay an arrival slightly; the delay is logged.
- **Devices:** 60% arrive on a phone-sized screen (360 × 780), 40% on a desktop (1280 × 800). This exercises the
  layout real visitors see; it does not change any decision below.
- **Seeded:** every random draw comes from a seeded generator, one stream per visitor (`--seed`). The same seed gives
  the same visitors, the same types and the same dice. The variant each visitor gets still comes from Flagsmith's
  bucketing of its fresh id, so two runs with one seed are not identical in outcome, only in behaviour.

## Visitor types (plan §6, fixed)

| Type | Share | First message |
|---|---|---|
| **Unsure** | 50% | Suggested replies shown: taps one 70% of the time, otherwise leaves. None shown: writes their own first message 35% of the time, otherwise leaves. |
| **Knows what they want** | 30% | Types their own first message 85% of the time, examples or not (never taps one). Otherwise leaves. |
| **Browser** | 20% | Leaves without sending 90% of the time. The other 10% send one: they tap a suggested reply if one is shown, or type their own if not. |

How a visitor gets there: it waits 2–5 seconds on arrival (reading the greeting; this also gives the app time to
decide the version, as it would for a person). A Browser who is leaving leaves now, without ticking anything. Every
other visitor ticks the consent box that the plan builder asks for before the first message, waits 0.5–1.5
seconds, and then looks for the suggested replies. What it saw is logged as **examples shown**, **no examples**, or
**did not look** (a Browser who left before the consent box).

## After the first message (fixed here)

The simulator does not know the version, so these rates are the same in both versions. Any difference in review or
signing between the versions comes only from who sent a first message.

| Type | Goes on to "review my plan" (of those who sent a first message) | Signs (of those who reached review) |
|---|---|---|
| Unsure | 50% | 60% |
| Knows what they want | 75% | 80% |
| Browser | 20% | 30% |

- A visitor who does **not** go on to review leaves after the agent's first reply.
- A visitor who goes on keeps chatting, waits for each reply, then taps **Review in plain language** (the plan
  builder offers it once the plan has its trusted people, after the second message). On the review it reads for
  3–8 seconds, then either taps **Sign and lock** or leaves.
- A visitor who taps a suggested reply first keeps tapping the first suggested reply on each turn; one who typed
  first keeps typing.

## Messages per visitor (for the `plan_message` guardrail)

| Type and path | Messages sent |
|---|---|
| Leaves after the first reply (any type) | 1 |
| Unsure, tapping suggested replies, going on to review | 3 (one per suggestion row: the plan, the trusted people, the car) |
| Unsure, typing their own, going on to review | 3 or 4 (even chance) |
| Knows what they want, going on to review | 2 or 3 (even chance) |
| Browser, going on to review | 2 |

## What these numbers imply (so the results can be checked against them)

Expected rates per visitor who reaches the plan builder, from the tables above:

| | `control` (examples shown) | `blank` (no examples) |
|---|---|---|
| `plan_first_message` | 62.5% | 45.0% |
| `plan_reviewed` | 37.0% | 28.3% |
| `plan_signed` | 25.9% | 20.7% |
| `plan_message`, mean per visitor | 1.27 | 0.96 |
| `plan_message`, mean per visitor who sent one | 2.03 | 2.13 |

So, by construction, the simulation has a true effect: control's first-message rate is about 39% above blank's.
A run that shows this effect shows that exposure, events, the split and the results all work, and how clearly an
effect of this size shows at this sample size. It is an effect **we put in**, not a finding.

## Leaving cleanly (so events are not lost)

Before a visitor's browser closes, the simulator tells the page it is being hidden (`visibilitychange` to hidden,
then `pagehide`), which is when the app flushes its Flagsmith events. It then waits until no request to Flagsmith has
been in flight for 1.5 seconds (at most 10 seconds) before closing. This is also the "flush on leave" wiring check
(plan §5a), run once per visitor.

## What it proves, and what it doesn't

- **Proves:** on the deployed site, a fresh visitor gets a stable id and a version; the screen it sees matches that
  version; exposures and the three conversion events and the guardrail arrive with the right id; the split stays near
  50/50 with no sample ratio mismatch; Flagsmith's results, and shipping the winner through the flag, behave as they
  would with people. It also shows how large an effect a sample of this size can detect.
- **Does not prove:** anything about how people behave. The visitor types and their rates above are our assumptions,
  written down in advance. The simulated "winner" is the one we built in.

## Keeping it apart

- Simulated visitors go only to the **Simulation** Flagsmith environment (the Simulation deployment's key), never to
  Production. Simulated and real results are never added together or shown on one chart.
- Every run log (`scripts/simulate/runs/<time>.json`) and every result taken from the Simulation environment is
  labelled **simulated**. A `--smoke` run (one visitor who always goes all the way, for checking the script) is also
  labelled as a smoke run and is left out of any results.
