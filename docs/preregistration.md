# Pre-registration: worked examples in the plan builder

Frozen at the `prereg` tag. Nothing below changes after that tag. Bug fixes made during the run are logged in
[status.md](../status.md), and the experiment is never restarted.

Toggle Wars (WeMakeDevs × Flagsmith), Track 01. Source: [plan.md §2](../plan.md#2-the-experiment-pre-registration-frozen-once-committed-before-26-nov-0430).
All times are SAST (UTC+2).

## The experiment

- **Name:** Worked examples in the plan builder.
- **Where:** `/will`, the plan builder. The owner types, in their own words, who should be looked after; the agent
  turns it into rules.

## Flag and versions

- **Flag:** `plan_builder_examples` (multivariate, string).
  - `control` (the flag's own value): today's screen. The suggested replies show under the greeting
    ("R1,500 a month for Lerato's books…").
  - `blank` (variation key `blank`): the same greeting and the same composer, with no suggested replies.

## Hypothesis

People don't know how to describe an estate plan. Seeing worked examples makes the first step easy, so with examples
at least 15% more visitors send a first message, and more reach "review my plan".

## Metrics

- **Primary:** `plan_first_message`, the visitor sends their first message (typed or tapped). Occurrence, expected
  to increase. It fires early in a visit, as the organisers advise.
- **Secondary:**
  - `plan_reviewed`: reached "review my plan". Occurrence, expected to increase.
  - `plan_signed`: signed the plan. Occurrence, expected to increase.
- **Guardrail:** `plan_message` (every message sent). Mean per visitor, should not increase. If `blank` wins only
  because people type far more to get the same plan, that is not a win.

## Exposure, split and identity

- **Exposure:** recorded only when the plan builder screen is actually shown with the flag's value, via
  `trackExposureEvent`, never on page load elsewhere.
- **Split:** 100% of visitors who reach the plan builder enter the experiment, 50/50, bucketed on the identity.
- **Identity:** a random anonymous id (UUID) made on the device and kept in local storage. No name, wallet, email,
  IP or chat text is ever sent.

## Sample

Flagsmith shows results from 50 identities and 5 conversions per version. Our target is at least 150 real visitors
per version. The simulation runs 1,000 visitors per version, in its own Simulation environment, and is reported
separately and labelled as simulated.

## Stopping rule

- **Start:** when the Production experiment is started in Flagsmith. The exact start time is recorded in
  [status.md](../status.md) and on the experiment page. The target is Fri 27 Nov, morning.
- **Stop:** **Sat 28 Nov 14:00 SAST**, whatever the numbers show.
- No early stop for a good result, and no extension for a bad one. Bayesian results can be read at any time: we look
  every 12 hours, but decide only at the stop.

## Worth shipping (practical significance)

A relative lift of at least 10% on the primary metric. A smaller "certain" lift is reported, not shipped.

## Decision rule

Fixed now:

- Ship `blank` only if its chance to beat control on the primary metric is at least 95%, its lift is at least 10%,
  and the guardrail doesn't get worse.
- Keep `control` if control's chance to be best is at least 95%.
- Otherwise call it inconclusive (the 95% credible interval crosses zero). Keep `control` as the safer default and
  say so honestly.

## Ship the winner

End the experiment, then set the flag's value to the winner, so every visitor gets it with no redeploy.

## Kill switch and kill criteria

- **Kill switch:** a second flag, `experiments_enabled` (boolean). When off, everyone sees `control` and nothing is
  sent.
- **Kill criteria, agreed now:** we turn the kill switch off if the plan builder errors more than before, or if any
  personal data is found in an event. Either would be logged in status.md and reported in the results.

## One change only

Nothing else on `/will` changes while the experiment runs, so control stays clean.

## Deviation from the plan

The plan said this pre-registration would be committed before Thu 26 Nov 04:30 and the Production experiment would
start on Thu 26 Nov at 06:00. That slipped. This pre-registration was committed on the evening of Thu 26 Nov, before
any experiment started and before any data existed. Only the start time changed: the experiment now starts when it is
started in Flagsmith (target Fri 27 Nov, morning), and the stop stays at Sat 28 Nov 14:00. Nothing else in plan §2
changed. The run is shorter than the planned 56 hours, so it may end inconclusive more easily; the decision rule
already allows for that.
