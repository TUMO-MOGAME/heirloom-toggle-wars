# Toggle Wars: the brief, the rules and our plan

The Flagsmith Experimentation Hackathon by WeMakeDevs, online, 26–29 November 2026.
Page: https://www.wemakedevs.org/hackathons/flagsmith

## Key dates

| When | What |
|---|---|
| 23 Nov, 8:30 PM IST (5:00 PM SAST) | Webinar with the Flagsmith team: https://www.youtube.com/live/wm2mKxQDpHQ |
| 26 Nov, 8:00 AM IST (4:30 AM SAST) | Hacking begins |
| 29 Nov, 8:00 PM IST (4:30 PM SAST) | Submissions close. Late entries are not accepted |

## Our track: Track 01, Test Something Real ($2,000)

> Build an app and run a real A/B test on it with Flagsmith Experimentation. The experiment is what counts, not the
> size of the app. You don't need real users: simulated traffic is fine.

What the judges look for in this track:
- One experiment done well beats many features.
- A clear hypothesis to test.
- The versions behind a flag.
- A metric from real events.
- Results you can explain.

Their tip: with four days of data, pick a metric that fires early in a visit, like a click or a first action.

## The scorecard (every track)

1. **Use of Flagsmith:** is it a core part, and do the flags or experiments do real work?
2. **Impact:** does it solve a real problem that people would use?
3. **Creativity:** is it a new idea, or a familiar idea taken somewhere new?
4. **Demo video:** does it clearly show the problem, what was built and how Flagsmith fits in?

## The rules, in short

1. Teams of 1 to 4. Each person is on one team, and each team submits one project.
2. Every team member registers with a WeMakeDevs account.
3. Hacking runs from 26 Nov, 8:00 AM IST, to 29 Nov, 8:00 PM IST.
4. A head start is allowed: trying Flagsmith and building with it before the start is fine.
5. Flagsmith must be a core part of the project. One track per entry.
6. Frameworks, open-source libraries, public APIs and public datasets are allowed.
7. AI coding assistants are allowed, but you must understand the code and be able to explain it.
8. The submission needs a public GitHub repo, a README with setup steps and how Flagsmith is used, and a short demo video.
9. It is online, free, and open worldwide.
10. You own what you build.
11. The WeMakeDevs Code of Conduct applies. Plagiarism or tampering with judging means disqualification.
12. Judging decisions are final.

## What was here before the hackathon

Heirloom, a family inheritance planner on Solana, was built before this event, for W3Node (submitted 13 Nov) and
Dev3pack (27–29 Nov, run in its own repo). None of it is Toggle Wars work:
- `3461429` Starting point: Heirloom as of `a202bc0`.
- `eaa5ba6` and `c6d6725` "Bring in Heirloom up to …": Heirloom's own later work, copied in from its repo.

The Toggle Wars work is everything else: the brief and plan, the pre-registration, the experiment layer in
`app/src/lib/experiments/` and its wiring in the plan builder, `/try`, the Flagsmith scripts, the simulator and the
results.

## The experiment

Flagsmith's own list of ideas includes "Empty first screen vs one with sample data". Ours is that idea, applied to
something people find hard: writing down who should be looked after when they die.

- **Where:** the plan builder (`/will`), where an owner tells the agent in their own words what their family needs.
- **Flag:** `plan_builder_examples`, multivariate.
  - `control`: today's screen, with worked examples to tap ("R1,500 a month for Lerato's books…").
  - `blank`: the same greeting, with no examples.
- **Hypothesis:** worked examples help people start. With examples, at least 10% more visitors send their first
  message, and more of them reach "review my plan". (The first draft said 15%; it was set to 10%, the same bar as
  "worth shipping", before the `prereg` tag and before any data existed: see
  [preregistration.md](preregistration.md#deviation-from-the-plan).)
- **Primary metric:** `plan_first_message`. It fires early in a visit, as the organisers advise.
- **Secondary metrics:**
  - `plan_reviewed`: reached "review my plan".
  - `plan_signed`: signed the plan.
- **Split:** 50/50 on a random anonymous ID made on the device. A visitor is counted only when the plan builder is
  actually shown.
- **Traffic:** real visitors, plus a simulator that drives real browser sessions on the demo site. Simulated
  results are labelled as simulated.
- **End:** read the win probability and credible interval, end the experiment, and ship the winner with the same flag.

## Ground rules

- The flag only changes the screen. Money rules, limits and signing stay enforced by the Solana program.
- No names, wallets or chat text go to Flagsmith, only the anonymous ID and event names.
- If Flagsmith is missing or down, the app shows `control`, sends nothing and never waits on it.
- Keys live in `.env.local` and Vercel, never in this repo.
