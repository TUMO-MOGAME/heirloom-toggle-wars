# Toggle Wars: status

> Read this first. The plan is [plan.md](plan.md); the brief and rules are [docs/toggle-wars.md](docs/toggle-wars.md).

**Last updated:** 2026-11-23
**Phase:** prework (allowed by rule 4). Hacking opens Thu 26 Nov 04:30 SAST; we finish Sat 28 Nov and submit by Sun 29 Nov 12:00 SAST.

## Done
- 23 Nov: public repo created from Heirloom a202bc0 (fresh history, prior work disclosed); brief, rules and full plan
  written; Heirloom's own plan and status moved to `docs/heirloom/`.

## Next up
- Tumo: T1–T9 (plan §5): register, webinar questions, Discord, Flagsmith account and three environments, keys in
  `.env.local`, CLI login, Vercel project, submission form fields.
- Claude: C1–C12 (plan §5), starting with C1–C4 (no key needed); C7 onwards needs Tumo's T4–T6.

## Decisions log
- 23 Nov: separate repo, not Heirloom's (keeps the Dev3pack repo stable, shows what was built for this event).
- 23 Nov: primary metric is `plan_first_message` (the organisers advise a metric that fires early in a visit).
- 23 Nov: real and simulated traffic in separate Flagsmith environments, never mixed; A/A check first.

## Blockers
- Unknown whether the free Flagsmith Cloud plan includes Experimentation (ask at the webinar or in Discord).
