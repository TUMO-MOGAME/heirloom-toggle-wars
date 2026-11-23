# Heirloom × Flagsmith (Toggle Wars, WeMakeDevs, Track 01)

At the start of every session, read `status.md` first, then the parts of `plan.md` you need.
At the end of every session (or after any milestone), update `status.md`: Done, Next up, Decisions log, Blockers.

- **Deadline:** Sun 29 Nov 2026, 16:30 SAST (20:00 IST). Our own deadline is 12:00 SAST (README and video done Saturday). Late entries are refused.
- **Scope:** one experiment done well (plan.md §2). Don't add features that don't serve the experiment, the
  results or the submission.
- **Pre-registration:** after the `prereg` tag, never change the hypothesis, metrics, split, stopping rule or
  decision rule. Log any bug fixes made during the run in `status.md`.
- **Data:** keep real (Production) and simulated (Simulation) results apart, always. Label simulated data as simulated.
- **The flag only changes the screen.** Money rules stay enforced by the Solana program.
- **No personal data to Flagsmith:** only the anonymous id and the typed event names.
- **Keys:** client-side environment keys go in the git-ignored `.env.local` and in Vercel. Admin keys are never in
  the repo. Never print a key, and run a secret scan before every push.
- **Never block the page:** the app falls back to `control` without Flagsmith, and the SDK loads after first paint.
- **App conventions:** all UI copy lives in `app/src/content`; use design tokens; write tests for every experiment
  rule.
- **This repo is separate from Heirloom's own repo and sites** (heirloom-one-iota, heirloom-devnet). Never push to
  them or change them from here.
- **Prior work:** the first commit is Heirloom before this event. Say so in the README; never present it as new.
