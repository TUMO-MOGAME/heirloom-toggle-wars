# Toggle Wars: the plan to win Track 01

The Flagsmith Experimentation Hackathon (WeMakeDevs), 26–29 November 2026. Track 01, **Test Something Real**, $2,000.
Brief and rules: [docs/toggle-wars.md](docs/toggle-wars.md). Heirloom's own plan and status, from before this event:
[docs/heirloom/](docs/heirloom/).

All times are **SAST** (South African time, UTC+2). IST is 3½ hours ahead.
**Deadline: Sunday 29 Nov, 16:30 SAST** (20:00 IST). **Our deadline: Sunday 29 Nov, 12:00 SAST.** The organisers'
advice is to finish the README and video on Saturday and keep Sunday as a buffer ("The video cannot be recorded in
the last hour"). Late entries are not accepted.

---

## 1. How we win

Judges score four things: use of Flagsmith, impact, creativity, and the demo video. For Track 01 they also look for
one experiment done well, a clear hypothesis, versions behind a flag, a metric from real events, and results you can
explain. Most entries will test a button colour on a toy app. Ours stands out in five ways:

1. **A real problem, a real app.** 66% of South Africans have no will. Heirloom is a working inheritance planner
   (live on Solana devnet), and the test is on its hardest step: saying what your family needs in your own words.
2. **Pre-registered.** The hypothesis, metrics, split, sample size, stopping rule and decision rule are committed to
   this repo before the experiment starts. The commit time proves we didn't move the goalposts. Few entries will do this.
3. **Two experiments, kept apart.** One runs on real visitors in Flagsmith's Production environment. A separate one
   runs on simulated visitors in a Simulation environment. We report each on its own and never mix them.
4. **Checked before trusted.** An A/A test (two identical versions) runs first, to prove the pipeline is fair:
   exposures split 50/50, no sample ratio mismatch warning, and no false winner.
5. **Results read honestly.** The organisers say teams most often stumble on "results you can explain". So we
   report the chance to beat control **together with** the 95% credible interval, the expected loss, and the
   practical size of the change (is the lift worth shipping?). If the interval crosses zero, we say "not a win yet"
   and how much more traffic would settle it. A null result is normal and honest; overselling is what loses points.
6. **The flag is the mechanism.** The organisers' test for "use of Flagsmith" is to remove Flagsmith and see if the
   behaviour changes. Here the flag decides what each visitor sees, the events decide the result, and the winner
   ships by changing the flag. The app has no other switch.
7. **The full loop on video.** Flag, metric, split, results, win probability, and then the winner shipped with the
   same flag: the organisers' four rounds, shown end to end in under three minutes.

| Scorecard | How we earn it |
|---|---|
| Use of Flagsmith | Multivariate flag; exposures via `trackExposureEvent`; three metrics from real events; Bayesian results; a kill switch flag; the winner shipped by flag; set up with the Flagsmith CLI and API, scripted in the repo |
| Impact | A real decision on a real product, with real visitors. The result changes what Heirloom ships |
| Creativity | The organisers' "empty first screen vs sample data" idea, applied to writing a will in plain words, plus pre-registration and an A/A check |
| Demo video | Problem, then the two versions side by side, then the flag in Flagsmith, the live results and the win probability, then shipping the winner |

---

## 2. The experiment (pre-registration; frozen once committed before 26 Nov 04:30)

- **Name:** Worked examples in the plan builder.
- **Where:** `/will`, the plan builder. The owner types, in their own words, who should be looked after; the agent
  turns it into rules.
- **Flag:** `plan_builder_examples` (multivariate, string).
  - `control` (the flag's own value): today's screen. The suggested replies show under the greeting
    ("R1,500 a month for Lerato's books…").
  - `blank` (variation key `blank`): the same greeting and the same composer, with no suggested replies.
- **Hypothesis:** people don't know how to describe an estate plan. Seeing worked examples makes the first step easy,
  so with examples at least 10% more visitors send a first message, and more reach "review my plan".
  (Changed from 15% on 26 Nov, before the `prereg` tag; [docs/preregistration.md](docs/preregistration.md) is the
  frozen version and wins over this section.)
- **Primary metric:** `plan_first_message`, the visitor sends their first message (typed or tapped).
  Occurrence, expected to increase. It fires early in a visit, as the organisers advise.
- **Secondary metrics:**
  - `plan_reviewed`: reached "review my plan". Occurrence, expected to increase.
  - `plan_signed`: signed the plan. Occurrence, expected to increase.
- **Guardrail:** `plan_message` (every message sent). Mean per visitor, should not increase. If `blank` wins only
  because people type far more to get the same plan, that is not a win.
- **Exposure:** recorded only when the plan builder screen is actually shown with the flag's value, via
  `trackExposureEvent`, never on page load elsewhere.
- **Split:** 100% of visitors who reach the plan builder enter the experiment, 50/50, bucketed on the identity.
- **Identity:** a random anonymous id (UUID) made on the device and kept in local storage. No name, wallet, email,
  IP or chat text is ever sent.
- **Sample:** Flagsmith shows results from 50 identities and 5 conversions per version. Our target is at least 150
  real visitors per version. The simulation runs 1,000 visitors per version.
- **Stopping rule:** the real experiment runs from Thu 26 Nov 06:00 to **Sat 28 Nov 14:00** (56 hours), whatever
  the numbers show. No early stop for a good result, and no extension for a bad one. Bayesian results can be read at
  any time: we look every 12 hours, but decide only at the stop.
- **Worth shipping (practical significance):** a relative lift of at least 10% on the primary metric. A smaller
  "certain" lift is reported, not shipped.
- **Decision rule, fixed now:**
  - Ship `blank` only if its chance to beat control on the primary metric is at least 95%, its lift is at least
    10%, and the guardrail doesn't get worse.
  - Keep `control` if control's chance to be best is at least 95%.
  - Otherwise call it inconclusive (the 95% credible interval crosses zero). Keep `control` as the safer default and
    say so honestly.
- **Ship the winner:** end the experiment, then set the flag's value to the winner, so every visitor gets it with no
  redeploy.
- **Kill switch:** a second flag, `experiments_enabled` (boolean). When off, everyone sees `control` and nothing is
  sent.
- **Kill criteria, agreed now:** we turn the kill switch off if the plan builder errors more than before, or if any
  personal data is found in an event. Either would be logged in status.md and reported in the results.
- **One change only:** nothing else on `/will` changes while the experiment runs, so control stays clean.

---

## 3. Ground rules

- **The flag only changes the screen.** Money rules, limits, quorums and signing stay enforced by the Solana program.
- **No personal data.** Nothing personal goes to Flagsmith, only the anonymous id and event names; event values are
  numbers only. A test checks that.
- **Never blocks the page.** Without a key, or if Flagsmith is down or slow, the app shows `control`, sends nothing,
  and never waits on it. The SDK loads after first paint, so speed stays at Lighthouse 90+.
- **Privacy policy.** It gets Flagsmith added as an operator: what is sent, why, where it is hosted, the cross-border
  transfer, and that the id is a random one in local storage that can be cleared. No cookies, so no cookie banner.
- **Keys.** The client-side environment keys go in the git-ignored `.env.local` and in Vercel. Any admin or
  organisation key is used only from the CLI on Tumo's machine, never in the repo or on Vercel.
- **Honest simulation.** The simulator's visitor types and their behaviour are published in `docs/simulation.md`
  before it runs. Results are labelled "simulated" everywhere, and never added to the real numbers.
- **Disclosed prior work.** The first commit is Heirloom as it was before the event, and the README says so up front.

---

## 4. Architecture

```
Browser (demo site, mock service: the agent's replies are canned, so every visit is free and the same)
  lib/experiments/
    identity.ts     random anon id in localStorage (try/catch; falls back to an in-memory id)
    flagsmith.ts    lazy import of @flagsmith/flagsmith after first paint; init({ environmentID, enableEvents: true }),
                    identify(anonId), getValue('plan_builder_examples'), trackExposureEvent, trackEvent,
                    flushEvents on visibilitychange / pagehide; a 1.5 s timeout falls back to control
    use-variant.ts  React hook: "control" until ready; the value never changes once the screen has shown it
    events.ts       the only allowed event names (typed), so a typo can't silently send nothing
  components/screens/will.tsx   reads the variant, hides the chips for "blank", sends the four events

Flagsmith Cloud
  Project "Heirloom"
    Environment "Production"   real visitors (heirloom-toggle-wars.vercel.app)
    Environment "Simulation"   simulator only (a Vercel preview deployment with the Simulation key)
    Environment "Development"  local and the A/A test
  Each environment: warehouse connected, flag + variation, metrics, experiment

scripts/flagsmith/
  setup.sh          CLI/API: flags, variation, metrics, experiment for one environment (idempotent, prints ids)
  results.ts        refresh + fetch results, write docs/results/<env>-<time>.json (needs the admin key; local only)
scripts/simulate/
  simulate.ts       Playwright: N visitors with a fresh identity each, through the real site, by visitor type
```

**Deployments:** a new Vercel project, `heirloom-toggle-wars`, deploys `main` in mock mode to production, and the
`simulation` branch to a preview URL with the Simulation key. It is separate from Heirloom's own two sites, which
this repo never touches.

**A short link straight to the test:** `/try` opens the demo as a new owner with no plan, straight on the plan
builder. Real visitors from a shared link land on the screen under test, instead of losing most of them on the way.
`/try` is just a route; the test itself still starts at the plan builder.

---

## 5. Work list (who, what, when; ✅ when done)

### Tumo, before Wed 25 Nov
- [ ] **T1** Register on the hackathon page (WeMakeDevs account). Every team member registers.
- [ ] **T2** Watch the 23 Nov webinar (17:00 SAST) or its recording. Ask two questions, in Discord if the webinar is
  missed:
  - Does the free Cloud plan include Experimentation with the managed warehouse?
  - Where is the data stored?
- [ ] **T3** Join the Flagsmith Discord, from the resources page.
- [ ] **T4** Create a Flagsmith Cloud account, an organisation, and a project "Heirloom" with three environments:
  Development, Simulation, Production.
- [ ] **T5** Put each environment's **client-side** key in `C:\Users\tumom\Hackathons\heirloom-toggle-wars\.env.local`
  as `FLAGSMITH_ENV_KEY_DEV=`, `FLAGSMITH_ENV_KEY_SIM=` and `FLAGSMITH_ENV_KEY_PROD=`.
- [ ] **T6** Install the Flagsmith CLI and run `flagsmith login` yourself. Claude never handles your password.
- [ ] **T7** Connect the Vercel account to this repo (new project `heirloom-toggle-wars`), or tell Claude to do it with
  the Vercel CLI.
- [ ] **T8** Star github.com/Flagsmith/flagsmith (the AirPods draw, and good manners towards the sponsor).
- [ ] **T9** Check the submission form's fields once logged in (repo, video, track, description…), and screenshot
  them for Claude.

### Claude, prework (Mon 23 – Wed 25 Nov)
- [ ] **C1** Repo set-up:
  - A new CLAUDE.md for this repo, plus a status.md.
  - The README restructured: the experiment comes first, and Heirloom's long README moves to `docs/heirloom/README.md`.
- [ ] **C2** `lib/experiments` (section 4) with `@flagsmith/flagsmith` ^12.4.0, plus the content strings in
  `app/src/content`.
- [ ] **C3** Tests (vitest):
  - With no key, the result is control and nothing is sent.
  - A timeout falls back to control.
  - Only allowed event names can be sent.
  - No event carries text or personal data.
  - Exposure is sent once, only when the screen shows.
  - The variant is stable after it has been shown.
  - The kill switch works.
- [ ] **C4** Wire `/will`: `blank` hides the chips. Events: `plan_first_message`, `plan_message`, `plan_reviewed`,
  `plan_signed`.
- [ ] **C5** The `/try` route: a fresh demo owner, landing on the plan builder. Copy in content; works on phones.
- [ ] **C6** Privacy policy: add Flagsmith as an operator (section 3). Update the terms if needed.
- [ ] **C7** `scripts/flagsmith/setup.sh` (CLI + API) and `results.ts`. Dry run on Development.
- [ ] **C8** The simulator (Playwright) and `docs/simulation.md`, with visitor types and their behaviour fixed before
  any run.
- [ ] **C9** Deploy: the Vercel project, env keys per environment, CSP updated for Flagsmith's API and events hosts.
- [ ] **C10** Launch checks on the deployed site:
  - 360 px and desktop, by touch.
  - Lighthouse 90+ on desktop and mobile is the goal.
  - axe check.
  - Events seen arriving in Flagsmith for each environment.
- [ ] **C11** The **A/A test** on Development: a flag `aa_check`, two identical versions, 400 simulated visitors.
  Pass if exposures are about 50/50, there's no sample ratio mismatch warning, and no false winner.
  Write it in `docs/results/aa-check.md`.
- [ ] **C12** Commit the frozen pre-registration (section 2) before Thu 26 Nov 04:30, as
  `docs/preregistration.md`, and tag `prereg`.

### Hackathon days (Thu 26 – Sun 29 Nov)
| When (SAST) | Who | What |
|---|---|---|
| Thu 26, 04:30 | — | Hacking opens |
| Thu 26, 06:00 | Claude | Start the **Production** experiment (`setup.sh prod` → start). Check the first exposures arrive in both versions |
| Thu 26, 07:00 | Tumo | Share the `/try` link widely (section 7) |
| Thu 26, 07:00 | Claude | Wiring checks (§5a) on Production |
| Thu 26, 08:00 | Claude | Start the **Simulation** experiment and run the simulator: 2,000 visitors over the day, not all at once |
| Thu 26 – Sat 28, every 12 h | Claude | Refresh results, save a snapshot to `docs/results/`, run the wiring checks, fix only real bugs (each fix is logged; the experiment is never restarted) |
| Fri 27 | Claude | Draft the README results section, `docs/toggle-wars-submission.md` and the video script with the numbers so far |
| Fri 27, evening | Tumo | A second share push. Read the video script |
| **Sat 28, 14:00** | Claude | **Stop:** final refresh, final snapshots and screenshots of both experiments |
| Sat 28, 14:30 | Claude + Tumo | Apply the decision rule, end both experiments, **ship the winner** through the flag on Production, and check the live site shows it |
| Sat 28, 16:00 | Tumo | **Record the video** (section 8). Claude edits captions and checks it against the scorecard |
| Sat 28, 19:00 | Claude | Final README, `docs/results.md`, `docs/toggle-wars-submission.md`; a fresh-clone test of the README |
| Sat 28, 20:00 | Tumo | Upload the video (YouTube) and paste the link into the README; Claude tags `submission` |
| **Sun 29, 09:00–12:00** | Tumo | **Submit** on the WeMakeDevs page from `docs/toggle-wars-submission.md`. Screenshot the confirmation. Sunday is otherwise a buffer |
| Sun 29, 16:30 | — | Official deadline |

---

## 5a. Wiring checks (the organisers' list of mistakes that void a result)

We check these on Development before the start, on Production 1 hour after the start, and at every 12-hour look:
- [ ] **Stable identifier.** The same visitor gets the same id on reload and on another page; the variation never
      flips.
- [ ] **Exposures on both sides,** roughly 50/50. Zero on one side means the flag is read in one place and the screen
      is drawn from another.
- [ ] **Conversions arrive.** If exposures rise but conversions stay flat, an event isn't firing. Events fire at the
      moment the action happens, with the same id, never on page load.
- [ ] **Multivariate from the start.** Never a boolean flag converted mid-test.
- [ ] **No sample ratio mismatch** warning in Flagsmith.
- [ ] **Flush on leave.** Events still arrive when a visitor closes the tab straight after acting.

## 6. The simulator (published before it runs)

- It uses Playwright, against the Simulation deployment only. Each visitor is a fresh browser context, so it gets a
  fresh anonymous id.
- Visitors arrive spread over time, so the experiment shows enrolment over hours rather than one spike.
- **Visitor types,** fixed before any run. The simulator reads only what is on the screen, never the flag's value:
  - **Unsure (50%).** Taps an example if one is shown (70%). With no example, writes their own first message 35% of
    the time. Otherwise leaves.
  - **Knows what they want (30%).** Types their own first message 85% of the time, examples or not.
  - **Browser (20%).** Leaves without sending 90% of the time.
  - After the first message, each type continues to review and signing at rates stated in `docs/simulation.md`.
- **What the simulation proves:** the whole pipeline works on the live site. Exposures, events, the split, the
  results and shipping the winner all behave as they would with people. It also shows how large an effect four days
  of traffic can detect. It does **not** prove how people behave; only the Production experiment speaks to that. The
  README says this in one plain sentence.

---

## 7. Getting real visitors (the organisers' tip: share widely)

- **Target:** 300+ visitors on the plan builder by Sun 10:00.
- **Where to share:**
  - WhatsApp family and community groups.
  - The WeThinkCode and Umuzi cohorts.
  - LinkedIn and X posts.
  - The WeMakeDevs and Flagsmith Discords, in the show-and-tell channels if allowed.
  - Friends who'd try a will planner.
- **Message (draft):** "I'm testing which version of my will-planner helps people start. It takes 1 minute, no
  sign-up, nothing real is saved: <link>/try". Claude writes the posts on Thu 26.
- No incentives that would skew who visits, and no asking people to pick a version.

---

## 8. The demo video (target 2:30, hard limit 3:00)

| Time | Shows | Says |
|---|---|---|
| 0:00–0:15 | Heirloom's plan builder | The problem: 66% of South Africans have no will, and the hardest step is the first sentence |
| 0:15–0:35 | Both versions side by side | The question and the hypothesis, read from the pre-registration commit |
| 0:35–1:05 | Flagsmith: the flag, the `blank` variation, the 50/50 split, the metrics, the experiment page | How it's wired: identity, exposure on screen, the events (10 s of code) |
| 1:05–1:20 | The A/A result | "First we proved the pipeline is fair" |
| 1:20–2:00 | Results: exposures over time, the conversion rate per version, lift, the credible interval, chance to be best (Production, then the clearly labelled Simulation) | What it means, in plain words, against the decision rule |
| 2:00–2:20 | Ending the experiment, changing the flag's value, the live site updating with no redeploy | Ship the winner with the same flag |
| 2:20–2:30 | Repo URL and track | Close |

- **Recording:** 1080p screen capture (OBS or the Xbox Game Bar), with captions burned in.
- **Narration:** Tumo's own voice, or an ElevenLabs voice. Never the browser's speech voice.
- **Upload:** to YouTube (unlisted or public), with the link in the README and the submission form.

---

## 9. What we submit (every item, with where it lives)

| Item | Where | Done when |
|---|---|---|
| Public GitHub repo | github.com/TUMO-MOGAME/heirloom-toggle-wars | Public, `main` at the `submission` tag |
| README: setup steps | README "Run it yourself" | A clean clone reaches the plan builder in under 10 minutes, tested on a fresh folder |
| README: how Flagsmith is used | README "How we used Flagsmith" | Flag, variation, identity, exposure, events, metrics, experiment, kill switch and shipping the winner, each with the file and line |
| README: the results | README "Results" and `docs/results.md` | Production and Simulation in separate tables, with screenshots, the decision against the pre-registered rule, and the limits |
| Pre-registration | `docs/preregistration.md`, tag `prereg` | Committed before Thu 26 Nov 04:30 SAST |
| A/A check | `docs/results/aa-check.md` | Passed, with a screenshot |
| Simulation method | `docs/simulation.md` | Committed before the simulator runs |
| Result snapshots | `docs/results/*.json` and screenshots | At least one every 12 h, plus the final one |
| Prior-work disclosure | README top and `docs/toggle-wars.md` | States the first commit is earlier work |
| Privacy policy update | Live site `/privacy` | Flagsmith listed as an operator |
| Live site | heirloom-toggle-wars.vercel.app (`/try`) | Shows the winner after the experiment ends |
| Demo video | YouTube link in the README and the form | Under 3:00, covers all four scorecard items |
| Submission form | WeMakeDevs page | Submitted by Sun 12:00 SAST (aim for 09:00); confirmation screenshot in `docs/toggle-wars-submission.md` |
| Submission text | `docs/toggle-wars-submission.md` | Title, one-liner, description, track, links, team; drafted Fri, final Sun |

---

## 10. README outline (final shape)

1. Title, the one-line pitch, and badges: track, live site, video.
2. **The result first:** the headline number and decision, for each experiment.
3. The problem, in three sentences.
4. The experiment: question, hypothesis, versions (two screenshots), metrics, split, decision rule, with a link to
   the pre-registration.
5. **How we used Flagsmith,** step by step with code links: flag, identity, exposure, events, metrics, experiment,
   CLI/API set-up script, kill switch, shipping the winner.
6. Results: Production, then Simulation (labelled), then the A/A check, then what we'd do next.
7. **Run it yourself:** prerequisites (Node 22+), clone, `npm ci`, `.env.local` from `.env.example`, `npm run dev`,
   create your own Flagsmith flag with `scripts/flagsmith/setup.sh`, and run the simulator.
8. Privacy and safety: what is and isn't sent, the fallback, the kill switch.
9. Prior work, honestly: what existed before 26 Nov, and the commit that marks it.
10. The team, and the licence.

---

## 11. Risks and what we do

| Risk | Plan |
|---|---|
| The free plan lacks Experimentation | Start the Flagsmith trial. If none is offered, self-host Flagsmith with Docker (Experimentation is on by default) on a small public VM, and also enter that story in the README |
| Too few real visitors | The decision rule already allows "inconclusive". The Simulation experiment still shows the full loop. Report honestly; never mix in simulated numbers |
| Events lost on page close | `flushEvents` on `visibilitychange`/`pagehide`. The simulator waits for the flush before closing |
| Experimentation beta bugs | Keep the result snapshots and screenshots every 12 h, so there's evidence even if the dashboard has problems |
| A visitor sees both versions | The variant is fixed once shown; Flagsmith quarantines any identity that sees both anyway |
| The flag is locked while running | Set the variations up right on Development first. The rollout percentage is the only thing we'd touch |
| Slow page from the SDK | Lazy-load after first paint; measure Lighthouse before starting |
| Dev3pack on the same weekend | All building is done by Wed 25. Thu to Sat is monitoring only. Sunday morning is set aside for this entry |
| A key leaked to the repo | Only client-side keys reach the browser (they're public by design); admin keys stay with the CLI on Tumo's machine; a secret scan runs before every push |
| The video runs late | The script is drafted Fri. Record by 12:30 Sun; a plain screen recording with captions is enough |

---

## 12. Definition of done (the final check before the form, Sat 28 21:00)

- [ ] The repo is public, the `submission` tag is pushed, and the working tree is clean.
- [ ] A clean clone builds and runs, following the README word for word.
- [ ] Tests, types and lint pass. `npm audit` shows no high issues.
- [ ] The live site shows the winning version. `/try` works at 360 px.
- [ ] Both experiments have ended, and the final results with screenshots are committed.
- [ ] The README covers: result first, setup, how Flagsmith is used, results, prior work, privacy.
- [ ] The video link works logged out, and the video is under 3:00.
- [ ] The submission form is filled in from `docs/toggle-wars-submission.md`, and the confirmation is screenshotted.

---

## 13. Sources read (23 Nov) and what each changed

| Source | What we took from it |
|---|---|
| [Hackathon page, rules, schedule](https://www.wemakedevs.org/hackathons/flagsmith) | Track 01 brief, scorecard, rules 1–12, dates |
| [Experimentation docs](https://docs.flagsmith.com/experimentation) and [coding-agent setup](https://docs.flagsmith.com/experimentation/set-up-with-a-coding-agent) | SDK ^12.4.0 with `enableEvents`; keyed variations ("one without a key records no exposures"); CLI/API setup; 50 identities and 5 conversions before results show; results refresh every 5 minutes at most; the flag is locked while running |
| [How to run a real A/B test with Flagsmith (WeMakeDevs)](https://www.wemakedevs.org/blogs/how-to-run-a-real-ab-test-with-flagsmith-experimentation) | A stable id in local storage; a default when Flagsmith is unreachable; the managed warehouse comes wired up; don't ship an 84% "winner" whose interval crosses zero; disclose synthetic traffic |
| [How to win Toggle Wars (WeMakeDevs)](https://www.wemakedevs.org/blogs/how-to-win-toggle-wars) | The video is 25% of the score; README and video on Saturday, Sunday as a buffer; the four wiring mistakes (§5a); the probability is "the model's current belief rather than a verdict"; one guardrail metric |
| [Bayesian A/B testing (Flagsmith)](https://www.flagsmith.com/blog/bayesian-a-b-testing) | How to explain chance to be best, the credible interval and expected loss in plain words; looking early is allowed, deciding early is not |
| [A/B testing in product management (Flagsmith)](https://www.flagsmith.com/blog/ab-testing-product-management) | One change per test; a decision rule and kill criteria agreed before launch; practical vs statistical significance; null results are common |
| [Flagsmith on GitHub](https://github.com/Flagsmith/flagsmith) | The open-source project to star (T8), and the place to check SDK source if the docs are unclear |
