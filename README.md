# Heirloom × Flagsmith: do worked examples help people start a will?

**One pre-registered A/B test on a real estate planner: does showing worked examples help more people write the first
sentence of their plan?**

Toggle Wars (WeMakeDevs × Flagsmith), 26–29 November 2026 · **Track 01: Test Something Real**

<!-- TODO: badges for the track, the live site (/try) and the video, once they exist. -->

> **Prior work, up front.** Heirloom, the app under test, was built before this event. The first commit of this repo
> (`3461429`) is Heirloom as it was before Toggle Wars. The later "Bring in Heirloom" commits (`eaa5ba6`, `c6d6725`)
> are also Heirloom's own work, copied in from its own repo, not new work. See [Prior work](#prior-work-honestly).

## The result

**Results pending: the experiment runs until Sat 28 Nov 14:00 SAST.**

| Experiment | Headline | Decision (against the [pre-registered rule](docs/preregistration.md#decision-rule)) |
|---|---|---|
| Production (real visitors) | TODO | TODO |
| Simulation (**simulated** visitors) | TODO | TODO |
| A/A check (pipeline fairness) | TODO | TODO |

## The problem

66% of South Africans have no will
([Sanlam Legacy Wills Survey 2025, via TimesLIVE](https://www.timeslive.co.za/news/south-africa/2025-09-19-66-of-south-africans-risk-family-feuds-by-dying-without-wills-sanlam-survey/)).
Heirloom lets a parent describe, in their own words, who should be looked after, and turns that into rules a
Solana program enforces. The hardest step is the first sentence: people don't know how to describe an estate plan.

## The experiment

The full pre-registration, frozen at the `prereg` tag, is in [docs/preregistration.md](docs/preregistration.md).

- **Question:** does showing worked examples on the plan builder help more people send their first message?
- **Hypothesis:** with examples, at least 15% more visitors send a first message, and more reach "review my plan".
- **Where:** `/will`, the plan builder.
- **Flag:** `plan_builder_examples` (multivariate, string).
  - `control`: today's screen, with suggested replies under the greeting ("R1,500 a month for Lerato's books…").
  - `blank`: the same greeting and the same composer, with no suggested replies.

  <!-- TODO: two screenshots, control and blank, side by side. -->
- **Primary metric:** `plan_first_message`, the visitor sends their first message (typed or tapped).
- **Secondary metrics:** `plan_reviewed` (reached "review my plan") and `plan_signed` (signed the plan).
- **Guardrail:** `plan_message`, every message sent, as a mean per visitor. It should not increase.
- **Split:** 50/50, bucketed on a random anonymous id. A visitor is counted only when the plan builder is actually
  shown.
- **Decision rule:** ship `blank` only if its chance to beat control on the primary metric is at least 95%, its lift
  is at least 10%, and the guardrail doesn't get worse. Keep `control` if control's chance to be best is at least 95%.
  Otherwise the result is inconclusive, and `control` stays as the safer default.
- **Stopping rule:** the Production experiment stops at Sat 28 Nov 14:00 SAST, whatever the numbers show.

## How we used Flagsmith

The flag decides what each visitor sees, the events decide the result, and the winner ships by changing the flag.
The app has no other switch. Line numbers are added once the code is final.

### Flag

`plan_builder_examples`, multivariate from the start, with a keyed `blank` variation.
Code: [`app/src/lib/experiments/`](app/src/lib/experiments/) <!-- TODO: file and line where the flag is read -->

### Identity

A random anonymous id (UUID), made on the device and kept in local storage. Nothing else identifies the visitor.
Code: [`app/src/lib/experiments/identity.ts`](app/src/lib/experiments/identity.ts) <!-- TODO: line numbers -->

### Exposure

`trackExposureEvent` is sent once, only when the plan builder screen is actually shown with the flag's value.
Code: [`app/src/lib/experiments/flagsmith.ts`](app/src/lib/experiments/flagsmith.ts),
[`app/src/components/screens/will.tsx`](app/src/components/screens/will.tsx) <!-- TODO: line numbers -->

### Events

Four typed event names, so a typo can't silently send nothing: `plan_first_message`, `plan_message`,
`plan_reviewed`, `plan_signed`. Events are flushed when the tab is hidden or closed.
Code: [`app/src/lib/experiments/events.ts`](app/src/lib/experiments/events.ts),
[`app/src/components/screens/will.tsx`](app/src/components/screens/will.tsx) <!-- TODO: line numbers -->

### Metrics

One primary (`plan_first_message`), two secondary (`plan_reviewed`, `plan_signed`) and one guardrail
(`plan_message`), each defined in Flagsmith from these events. <!-- TODO: screenshot of the metrics page -->

### Experiment

One experiment per environment: Production for real visitors, Simulation for simulated ones, Development for the
A/A check. They are never mixed. <!-- TODO: screenshot of the experiment page -->

### CLI and API set-up

The flags, the variation, the metrics and the experiment are created by script, not by hand.
Code: [`scripts/flagsmith/setup.sh`](scripts/flagsmith/setup.sh); results are fetched by
[`scripts/flagsmith/results.ts`](scripts/flagsmith/results.ts). <!-- TODO: usage and line numbers -->

### Kill switch

A second flag, `experiments_enabled` (boolean). When it is off, everyone sees `control` and nothing is sent.
Code: [`app/src/lib/experiments/`](app/src/lib/experiments/) <!-- TODO: file and line -->

### Shipping the winner

End the experiment, then set the flag's value to the winner. Every visitor gets it with no redeploy.
<!-- TODO: what was shipped, when, and a screenshot of the live site afterwards. -->

## Results

Results pending: the experiment runs until Sat 28 Nov 14:00 SAST. Full write-up: `docs/results.md` (to come);
snapshots every 12 hours in `docs/results/`.

### Production (real visitors)

<!-- TODO: exposures per version, conversion rate, lift, 95% credible interval, chance to beat control, expected
loss, guardrail; the decision against the pre-registered rule; screenshots. -->
TODO

### Simulation (simulated visitors, labelled as simulated)

These numbers come from a simulator, not from people. They show that the pipeline works end to end. They do not show
how people behave. The visitor types are published in `docs/simulation.md` before it runs.
<!-- TODO: same table as Production, clearly labelled simulated. Never added to the real numbers. -->
TODO

### A/A check

Two identical versions on Development, to prove the pipeline is fair: exposures about 50/50, no sample ratio mismatch
warning, and no false winner. Write-up: `docs/results/aa-check.md` (to come).
TODO

### What we'd do next

TODO

## Run it yourself

You need Node.js 22 or later.

```bash
git clone https://github.com/TUMO-MOGAME/heirloom-toggle-wars.git
cd heirloom-toggle-wars/app
npm ci
cp .env.example .env.local   # add your own Flagsmith client-side environment key
npm run dev
```

Open <http://localhost:3000/try>. It opens the demo as a new owner, straight on the plan builder.
Without a Flagsmith key the app shows `control` and sends nothing.
<!-- TODO: confirm the env var name in .env.example and that /try exists. -->

**Your own Flagsmith flag:** create a project and an environment in Flagsmith, log in with the Flagsmith CLI, then
run [`scripts/flagsmith/setup.sh`](scripts/flagsmith/setup.sh). It creates the flags, the variation, the metrics and
the experiment, and prints their ids. <!-- TODO: exact command and arguments. -->

**The simulator:** [`scripts/simulate/`](scripts/simulate/) drives real browser sessions (Playwright) against a
deployment that uses a separate Simulation environment. <!-- TODO: exact command. -->

The rest of Heirloom (chain mode on Solana devnet, the AI agent, voice) is set up as in
[docs/heirloom/README.md](docs/heirloom/README.md#run-it-locally).

## Privacy and safety

- **Sent to Flagsmith:** the random anonymous id, the flag evaluation, the exposure and the four event names. Event
  values are numbers only.
- **Never sent:** names, wallets, email, IP addresses or chat text. A test checks this.
  <!-- TODO: link the test. -->
- **Fallback:** without a key, or if Flagsmith is slow or down, the app shows `control`, sends nothing and never waits
  on it. The SDK loads after first paint.
- **Kill switch:** `experiments_enabled` off means everyone sees `control` and nothing is sent. We turn it off if the
  plan builder errors more than before, or if any personal data is found in an event.
- **The flag only changes the screen.** Money rules, limits, quorums and signing stay enforced by the Solana program.
- **Privacy policy:** Flagsmith is listed as an operator on the site's `/privacy` page. There are no cookies, so
  there is no cookie banner.
- **Keys:** client-side environment keys only, in the git-ignored `.env.local` and in Vercel. Admin keys never enter
  the repo.

## Prior work, honestly

Heirloom is a family inheritance planner on Solana. It was built before this event, for W3Node (submitted 13 Nov)
and Dev3pack. None of it is presented as Toggle Wars work.

| Commit | What it is |
|---|---|
| `3461429` Starting point | Heirloom as of `a202bc0`, before this event |
| `eaa5ba6` Bring in Heirloom up to `1fa6c33` | Heirloom's own work (reviewed devnet release, ElevenLabs voice), copied in |
| `c6d6725` Bring in Heirloom up to `676e768` | Heirloom's own work (security audit, Squads upgrade authority, Chip in, hardened program, guided run), copied in |

The Toggle Wars work is the experiment: the brief and plan ([docs/toggle-wars.md](docs/toggle-wars.md),
[plan.md](plan.md)), the pre-registration, `app/src/lib/experiments/`, the wiring in the plan builder, the `/try`
route, the Flagsmith scripts, the simulator and the results.

The full Heirloom product (what it does, the Solana program, Tether WDK, ElevenLabs, security notes) is described in
[docs/heirloom/README.md](docs/heirloom/README.md).

## Team and licence

Solo project: Tumo Mogame.

[MIT](LICENSE) © 2026 Tumo Mogame.

*Heirloom is a prototype on a test network. It is not a will, not financial or legal advice, and not audited. In South
Africa a will must still be signed on paper (Wills Act 7 of 1953); Heirloom sits next to it.*
