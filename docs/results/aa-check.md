# A/A check (plan C11): passed on run 2

**Simulated traffic, Development environment.** Two identical versions behind the flag `aa_check` (`control` and
variation `twin`, both showing the same screen), to prove the pipeline is fair before the real experiment starts.

## Pass criteria (plan C11)

Exposures about 50/50, no sample ratio mismatch, and no false winner on `plan_first_message`.

## Result: run 2, Flagsmith experiment 791 (26 Nov 2026, 21:24–21:55 UTC)

| Check | Result | Pass |
|---|---|---|
| Every visitor counted | 400 exposures from 400 simulated visitors (twin 213, control 187); 0 saw both | yes |
| Sample ratio | 213 / 187, chi-squared p = 0.19 (a mismatch would be p < 0.001) | yes |
| Events match the visitors | Flagsmith: 113 + 96 = 209 first messages; the simulator's own log: 209 | yes |
| No false winner | twin 53.1% vs control 51.3%; lift 3.3%, 95% credible interval −16.2% to +22.8% (Flagsmith), chance to win 63% | yes |

Snapshot: [aa-2026-11-26T21-55-33Z.json](aa-2026-11-26T21-55-33Z.json). Simulator log:
[2026-11-26T21-25-04-824Z.json](../../scripts/simulate/runs/2026-11-26T21-25-04-824Z.json) (seed
`aa-check-run2-2026-11-26`, 400 visitors over 30 minutes, the visitor types in [docs/simulation.md](../simulation.md)).

## Run 1 failed, and that is what the check is for

Run 1 (experiment 781, 20:48–21:19 UTC) counted only 130 of 400 visitors, every one of them a converter, so both
versions showed 100% conversion. The cause was in the simulator, not the app: its "leave the page" step threw a hidden
error under `tsx` (`__name is not defined`), so no simulated visitor flushed its events on leave, and only visitors who
stayed long enough for the SDK's own timer were counted. A plain-JavaScript probe showed the app itself flushes on
leave. The simulator was fixed (commit 8c4f039), checked with 8 visitors, and run 2 counted every visitor. Run 1 was
completed and its snapshot kept as evidence: [aa-2026-11-26T21-22-08Z.json](aa-2026-11-26T21-22-08Z.json).

Without the A/A check, the same bug would have made the Simulation experiment report 100% conversion in both versions.

## What this does and doesn't show

It shows that the split, the exposures, the events and Flagsmith's results agree with each other end to end. It says
nothing about how people behave; only the Production experiment speaks to that.
