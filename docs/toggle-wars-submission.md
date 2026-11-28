# Toggle Wars: submission form answers

> Final answers, Sat 28 Nov 2026 (results in). Copy each field into the WeMakeDevs form as-is. Only the video link is
> still **PENDING**. Submit Sun 29 Nov by 12:00 SAST.

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
```
https://heirloom-toggle-wars.vercel.app/try
```

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
The form shows checkboxes, not a text box. Tick: **Feature flags, Experimentation (A/B tests), Remote config,
Flagsmith CLI, Flagsmith API, Flagsmith Cloud.** Leave Segments, MCP server and Self-hosted unticked (tick
Self-hosted only if we move off Cloud). Untick CLI or API if they end up unused. The text below is for the README
and the description, if wanted:
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
Final: hypothesis, versions, split and metrics match the pre-registration; results from the final snapshots.
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

Two experiments, never mixed: one on real visitors (Production) and one on simulated visitors (Simulation, Playwright, visitor types published before it ran). An A/A check on Development first showed the pipeline is fair: 400 of 400 simulated visitors counted, split 213/187 (p = 0.19), Flagsmith's event count matched the simulator's own log exactly, and no false winner (interval -16% to +23%). Its first run failed and caught a real bug in our simulator before the real experiment started.

Results (SIMULATED visitors, Simulation environment): 2,004 visitors in real browsers, split 961/1,043 (p = 0.067). With examples, 62.1% sent a first message; without them, 42.6%. Blank: -31.5%, 95% credible interval -37.4% to -25.6%; control's chance to be best > 99%. Reviews (-26.3%), signed plans (-20.0%) and messages per visitor (-26.6%) all fell with it. Decision rule: keep control. The simulator has a known effect built in (blank -28% on first messages), and all four built-in effects fall inside Flagsmith's intervals: the pipeline finds a real difference of this size. That is an effect we put in, not a finding about people.

Results (REAL visitors, Production): 28.5 hours, 1 real visitor. Not enough for a result (Flagsmith needs 50 per version; we pre-registered 150), so by our rule it is inconclusive and control stays. It says nothing about people either way. We are honest about that: the pipeline is proven, the question about people is still open, and the next step is two weeks with real Heirloom users.

The experiments were ended 2 h 19 min after the pre-registered stop (Sat 14:00 SAST); no data changed in between.

Shipped: control, the version with worked examples, on Sat 28 Nov by completing both experiments in Flagsmith with control rolled out. No code change, no redeploy; checked on the live site right after.
```

### [Track 1] Experiment results (screenshots, up to 3)
Upload these three (all from the repo, `docs/results/screenshots/`):
1. `sim-2-results.png`: Simulation results: 2,004 enrolled, Control > 99%, blank -31.5% (caption: "Simulated visitors").
2. `sim-1-summary.png`: the experiment page: hypothesis, "Control is the winner", the 50/50 split.
3. `sim-3-conversions-over-time.png`: the two lines pulling apart (Production has 1 visitor, so its page shows
   nothing to see).

### Tracks 2–4
Not entered. Leave blank.

## Part 3

### What did you like about Flagsmith, and what would you improve?
Checked after the experiments ran on Flagsmith Cloud (27 Nov): the results page, the "Control is the winner"
banner and the charts worked as described; Flagsmith's SRM p-value did come back empty.
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
