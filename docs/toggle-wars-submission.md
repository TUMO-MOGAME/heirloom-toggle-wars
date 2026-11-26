# Toggle Wars: submission form answers

> Draft of 26 Nov 2026. Copy each field into the WeMakeDevs form as-is. Fields marked **PENDING** wait for the
> deployment, the experiment results or the video. Final check Sat 28 Nov; submit Sun 29 Nov by 12:00 SAST.

## Part 1

### Project title
```
Heirloom: does showing worked examples help people start writing their will?
```

### Which tracks are you entering?
```
Track 01: Test Something Real
```

### Demo video
**PENDING** (recorded Sat 28 Nov; YouTube, unlisted; under 3:00).

### GitHub repository
```
https://github.com/TUMO-MOGAME/heirloom-toggle-wars
```

### Live demo or deployment
**PENDING** (after deployment): `https://heirloom-toggle-wars.vercel.app/try`

### What did you build, and what problem does it solve?
```
66% of South Africans have no will. Heirloom is a working inheritance planner (live on Solana devnet, built before this hackathon and disclosed as prior work in the README): the owner describes, in their own words, who should be looked after and what the money is for, and an agent turns that into rules the family can see and a program enforces.

The hardest step is the first sentence. People don't know how to describe an estate plan. So for Toggle Wars we built a real experiment on that step: does showing worked examples ("R1,500 a month for Lerato's books…") help more people start?

What we built for the event:
- A Flagsmith experiment layer in the app: a random anonymous id kept on the device, the Flagsmith SDK loaded after first paint, a 1.5 s fallback to the current screen, a kill switch, and typed events so a typo can't silently send nothing.
- The plan builder wired to the flag: one version shows the worked examples, the other the same screen without them. The flag only changes the screen; money rules stay enforced by the on-chain program.
- A /try link that drops visitors straight onto the screen under test.
- Set-up and results scripts using the Flagsmith CLI and Admin API, so the flags, metrics and experiment are reproducible from the repo.
- A Playwright simulator with visitor types published before it ran, for a separate, clearly labelled Simulation experiment.
- A pre-registration committed to the repo before the experiment started: hypothesis, metrics, split, stopping rule and decision rule, so the goalposts can't move.

Who uses it: anyone planning what happens to their money and family after they're gone, and the Heirloom team, who will ship whichever version wins by changing the flag, with no redeploy.
```

### Which parts of Flagsmith did you use?
```
- Multivariate flag plan_builder_examples: control (worked examples) and a keyed variation "blank" (no examples), 50/50, bucketed on an anonymous identity.
- Boolean flag experiments_enabled as a kill switch: when off, everyone sees control and nothing is sent.
- Identities: a random UUID per device, passed at init. No name, wallet, email, IP or chat text is ever sent.
- Experimentation: trackExposureEvent when the plan builder is actually shown, and trackEvent for four events (plan_first_message, plan_message, plan_reviewed, plan_signed), flushed when the tab is hidden or closed.
- Metrics: plan_first_message (primary, occurrence), plan_reviewed and plan_signed (secondary), plan_message (guardrail, count per visitor, should not increase).
- Experiments and Bayesian results: chance to beat control, credible interval and lift, read against a decision rule fixed in advance.
- Three environments kept apart: Production (real visitors), Simulation (simulated visitors only) and Development (local work and an A/A check).
- The Flagsmith CLI and Admin API, scripted in the repo (scripts/flagsmith/setup.sh and results.ts), to create the flags, metrics and experiments and to save result snapshots.
- Shipping the winner: ending the experiment and changing the flag's value, so every visitor gets the winner with no redeploy.
```

## Part 2: Track details

### [Track 1] Walk us through your experiment
Hypothesis, versions, split and metrics are final (they match the pre-registration). The results paragraph is
**PENDING**: written from the final snapshot after the stop on Sat 28 Nov 14:00 SAST.
```
Hypothesis: people don't know how to describe an estate plan, so seeing worked examples makes the first step easier. With examples, more visitors send a first message and more reach "review my plan". We pre-registered this, with the metrics, split, stopping rule and decision rule, in docs/preregistration.md, tagged before the experiment started.

Versions behind the flag plan_builder_examples (multivariate):
- control: today's screen, with suggested replies under the greeting.
- blank: the same greeting and composer, with no suggested replies.
A second flag, experiments_enabled, is a kill switch.

Split: 100% of visitors who reach the plan builder enter the experiment, 50/50, bucketed on a random anonymous id stored on the device. The variant is fixed once shown, and the exposure is recorded only when the plan builder is actually on screen.

Metrics, from events sent by the app at the moment each action happens:
- Primary: plan_first_message, the visitor sends their first message (typed or tapped).
- Secondary: plan_reviewed (reached the review) and plan_signed (signed the plan).
- Guardrail: plan_message, messages per visitor, which should not rise. If "blank" wins only because people type far more to get the same plan, that is not a win.

Decision rule, fixed in advance: ship "blank" only if its chance to beat control is at least 95%, its lift is at least 10% and the guardrail doesn't get worse; keep control if control's chance is at least 95%; otherwise call it inconclusive and keep control.

Two experiments, never mixed: one on real visitors (Production) and one on simulated visitors (Simulation, Playwright, visitor types published before it ran). An A/A check on Development first showed the pipeline is fair. [PENDING: keep this sentence only if the A/A check passes; otherwise say what it found.]

Results: PENDING (final numbers after the stop on Sat 28 Nov 14:00 SAST).
```

### [Track 1] Experiment results (screenshots, up to 3)
**PENDING**. Planned three:
1. Production experiment results: conversion per version, lift, credible interval, chance to beat control.
2. Simulation experiment results (the screenshot caption says "Simulated traffic").
3. The A/A check, or Production exposures over time.

### Tracks 2–4
Not entered. Leave blank.

## Part 3

### What did you like about Flagsmith, and what would you improve?
Draft from building and reading the API and source; revise after the experiments have run on Flagsmith Cloud.
```
What we liked:
- The coding-agent set-up guide and the Experimentation docs were clear enough to wire exposures and events correctly on the first pass, including keyed variations and flushing events when the tab closes.
- trackExposureEvent and trackEvent are small and easy to keep free of personal data: we send an anonymous id, event names and numbers only.
- Bayesian results suit a short hackathon: we can look at any time without inflating false positives, as long as we decide only at the stop.
- Everything we set up by hand can also be scripted through the CLI and Admin API, so the experiment is reproducible from the repo.

What we'd improve:
- The sample ratio mismatch check reads the split from the environment default, which the experiment rollout sets to 0%, so its p-value can come back empty. We added our own chi-squared check.
- The API has no way to mark a metric as primary or guardrail; we rely on order and expected direction.
- Expected loss isn't reported; we compute it ourselves. It's the number that makes "should we ship?" easy to explain.
- Naming: the "count" aggregation is what most people mean by "mean per visitor", while "mean" averages event values. A line in the docs would save confusion.
- Creating an experiment through the API can apply its rollout before the experiment is started unless you disable it, which is easy to miss in Production.
- The terms describe both "no transfers outside the EEA" and copies across several AWS regions; a clear statement of where event data is stored would help teams writing POPIA and GDPR privacy notices.
```
