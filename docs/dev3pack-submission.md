# Heirloom: Dev3pack Global Hackathon submission (27–29 November 2026)

**Categories:** Best App Overall on Solana; Best Agentic App ([agentic entry](dev3pack-agentic.md)). **Country track:** South Africa, where offered.

## One sentence
Heirloom lets a parent put money in a Solana vault that pays their children's schools and other approved payees under
capped rules, while they are alive and after they are gone.

## The problem
When a South African parent dies, the estate can be frozen for a year or more, and 66% of adults have no will. The fee
money exists, but it can't reach the school, and a lump sum at the end has no protection for the children.

## What we built
- **A living plan.** Rules say who, for what, to which approved payee, up to how much. They work from the day they are
  signed and carry on after death.
- **An Anchor program that enforces it.** 58 instructions hold the vault and check payees, caps, quorums, waiting
  periods, objections and disputes. Payouts and the sale of an asset (money for title) settle atomically.
- **An AI reviewer that cannot approve what it is unsure of.** It reads documents with facts taken from the chain. When
  unsure it refers the item on-chain, and then two trusted people, or the living owner, decide.
- **No dead ends.** Monitors' objections and disputes lapse, a surplus has a named recipient, a listing can be renewed,
  and a lost agent key can be replaced.
- **Usable from nothing.** On devnet a new wallet gets test funds in the app, makes practice family wallets, and can
  sign, fund, claim and pay without a script or a faucet. The guided run does it all in one tab with no persona
  switching, and links each step to its transaction.

## Why it needs Solana
The promise has to outlive the person who made it and the company that built the app. The rules and the money sit in
program-owned accounts that anyone can audit and nobody, Heirloom included, can quietly change. Low fees make a
monthly book allowance practical, and fee sponsorship lets a family use it with no SOL for fees.

## Links
| | |
|---|---|
| Guided run on devnet: the whole story in one tab, 11 steps in about 1.5 minutes | https://heirloom.tumoolo.tech/start/guided |
| App on devnet | https://heirloom.tumoolo.tech |
| Simulated demo, every role in one browser | https://heirloom-one-iota.vercel.app |
| Program | [`b3PBVwkLnyx7eyLPNtc5J3Ds3os3cenqCVRHaCJM7FY`](https://explorer.solana.com/address/b3PBVwkLnyx7eyLPNtc5J3Ds3os3cenqCVRHaCJM7FY?cluster=devnet) |
| A full newcomer run on devnet | [README: proof](../README.md#proof-one-newcomer-start-to-payout) |
| Code | https://github.com/TUMO-MOGAME/dev3pack-Hackathon |
| Security audit | [docs/security-audit.md](security-audit.md) |
| Research and limits | [docs/research.md](research.md) |

## Work done before the event
Heirloom was started on 11 November 2026 and first submitted to the W3Node hackathon on 13 November 2026. It was
developed further from 14 to 22 November. The Dev3pack organisers allow prework. The commit history shows exactly
what existed before 27 November and what was added during the event.

## Limits
- Devnet and a test USD₮ mint only. Internally audited ([report](security-audit.md)); no third-party audit yet.
- Rand settlement to institutions is simulated and labelled.
- Institutions in the demos are wallets we control.
- No user interviews have been run yet, so we claim no user validation.
- The Android build has not been verified with a wallet app on a physical phone.

## Team
Tumo Mogame (solo): product, design, program and app.
