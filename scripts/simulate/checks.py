"""Two after-the-fact checks on the Simulation experiment. Read-only: nothing is sent to Flagsmith.

1. Reconcile: the simulator's own run logs against Flagsmith's counts, version by version.
2. Sample size: the smallest drop a test of each size can reliably spot, and how often the pre-registered decision
   rule finds the effect built into the simulator (docs/simulation.md) at each size.

Run from the repo root:  python scripts/simulate/checks.py
Needs numpy. Simulated data only; never add these numbers to the real (Production) results.
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RUNS = ["2026-11-27T07-29-11-646Z", "2026-11-27T07-41-29-303Z", "2026-11-27T07-41-32-694Z"]  # warm-up, a, b
SNAPSHOT = ROOT / "docs/results/sim-2026-11-27T14-12-28Z.json"
VERSION_OF = {"shown": "control", "not-shown": "blank"}  # what the simulated visitor saw on screen


def reconcile():
    logged = {v: {"visitors": 0, "plan_first_message": 0, "plan_reviewed": 0, "plan_signed": 0, "plan_message": 0}
              for v in ("control", "blank", "left before looking")}
    for run in RUNS:
        for v in json.loads((ROOT / f"scripts/simulate/runs/{run}.json").read_text())["log"]:
            c = logged[VERSION_OF.get(v["seen"], "left before looking")]
            c["visitors"] += 1
            c["plan_first_message"] += v["messagesSent"] > 0
            c["plan_reviewed"] += v["reviewed"]
            c["plan_signed"] += v["signed"]
            c["plan_message"] += v["messagesSent"]
    snap = json.loads(SNAPSHOT.read_text())["summary"]
    print("1. Simulator logs vs Flagsmith (simulated data)")
    print(f"   {'':22}{'control: log / Flagsmith':>26}{'blank: log / Flagsmith':>26}")
    for m in snap["metrics"]:
        row = [f"{logged[v][m['name']]} / {m['versions'][v]['total']}" for v in ("control", "blank")]
        ok = all(logged[v][m["name"]] == m["versions"][v]["total"] for v in ("control", "blank"))
        print(f"   {m['name']:22}{row[0]:>26}{row[1]:>26}   {'match' if ok else 'DIFFERENT'}")
    left = logged["left before looking"]["visitors"]
    n_logged = sum(c["visitors"] for c in logged.values())
    n_fs = sum(snap["exposures"].values())
    print(f"   visitors: {n_logged} logged, {n_fs} exposures in Flagsmith ({left} left before looking, so their version"
          f" isn't in the log; they sent no events)")


def sample_size(seed=20261128, runs=2000, draws=4000):
    pc, pb = 0.625, 0.45  # built-in first-message rates, docs/simulation.md
    z = 1.959964 + 0.841621  # two-sided 5%, 80% power
    rng = np.random.default_rng(seed)

    def smallest_drop(n, p=0.621):
        for d in np.arange(0.005, 0.9, 0.001):
            q = p * (1 - d)
            if (p - q) / np.sqrt(p * (1 - p) / n + q * (1 - q) / n) >= z:
                return d

    print("\n2. Sample size (first message; baseline 62%)")
    print(f"   {'visitors per version':>21}{'smallest drop spotted (80% power)':>36}{'rule finds the built-in effect':>33}")
    for n in (25, 50, 150, 500, 1000):
        hits = 0
        for _ in range(runs):
            c, b = rng.binomial(n, pc), rng.binomial(n, pb)
            hits += (rng.beta(1 + c, 1 + n - c, draws) > rng.beta(1 + b, 1 + n - b, draws)).mean() >= 0.95
        print(f"   {n:>21}{smallest_drop(n) * 100:>35.1f}%{hits / runs * 100:>32.1f}%")


if __name__ == "__main__":
    reconcile()
    sample_size()
