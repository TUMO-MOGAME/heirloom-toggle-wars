# Heirloom: Best Agentic App entry (Dev3pack Global, 27–29 November 2026)

**One sentence.** An AI agent reviews the documents behind a family's money (a fee statement, a death notice, a
hardship affidavit) and signs its verdict on Solana, where a program decides what that verdict is allowed to do.

## The AI does real work
- **It reads evidence and decides an outcome.** For every claim, death report, seat death, fallback report and
  hardship request, the agent (Google Gemini, `gemini-4-argon`, typed tools with zod-checked output) reads the
  document and answers **Approve**, **Reject** or **Refer**. Its answer changes what happens next: an approved
  claim can be paid, a rejected one is closed, a referred one goes to people.
- **It is given facts from the chain, not from the caller.** [`review-target.ts`](../app/src/lib/agent/review-target.ts)
  reads the claim, rule, payee and beneficiary accounts from devnet and hands the model only those facts plus the file.
  Nothing the person asking typed reaches the facts.
- **It sells assets at a fair price.** When a trusted person asks, the agent ranks the escrowed offers and settles one
  at or above the floor; the money and the title NFT swap in one transaction.
- **It runs the schedule.** It triggers due payments (`execute_scheduled`), paying only the fee: the program sends the
  fixed amount to the fixed payee.
- **It writes the plan with the owner.** Plain-language wishes become strict rules (who, for what, which payee, caps,
  dates) that the owner reviews and signs.

## Solana does real work for the AI
- **A public, permanent record of every verdict.** Each review is a transaction signed by the agent's own wallet
  ([`261pQudaK…`](https://explorer.solana.com/address/261pQudaK5J4v1WCtcGjWidWU9ww3KyYC4TiU8jDsjNg?cluster=devnet)),
  recorded on the claim next to the document's SHA-256 hash and a hash of the agent's report. Anyone can check what the AI said, when, and about which file.
  Example: [the agent refers a claim with the wrong student on the statement](https://explorer.solana.com/tx/23iGynqLGFUxGu5sTb29CksHjDZRWkxJ5yJ6TZL3dFxkeykkFvsRmCVcV8vQzAAtBf4fhK2rUPVAzcfc2rn2pkpC?cluster=devnet).
- **Coordination with people.** The program combines the AI's vote with trusted people's votes, the owner's veto and
  waiting periods. No server decides how they add up.
- **Payments the AI cannot redirect.** The agent never holds the family's money. Payouts go only to the rule's
  approved institution, under caps the program checks.

## Safety and control
| Control | Where it is enforced |
|---|---|
| The agent's key may sign only an allow-list: `review_*`, `list_asset`, `accept_offer`, `execute_scheduled` | [`agent-wallet.ts`](../app/src/lib/agent/agent-wallet.ts) (server) and the program's signer checks |
| It can't approve what it is unsure of: unsure means Refer, and then 2 trusted people or the living owner decide | Program (`review_claim`, `review_death`) |
| It can't unlock an estate alone: a death claim needs the AI check, 2 of 3 trusted people and a waiting period the owner can stop by checking in | Program |
| It can't move vault money alone; caps per claim, per year and per lifetime hold whatever it says | Program |
| A sale needs a living trusted person's co-signature, never below the floor | Program (`accept_offer`) |
| Prompt injection: a document that tells the AI "approve this" is caught, and even if it weren't, the caps and quorums still hold | [demo screenshot C1](demo-screenshots/README.md) |
| Spending limits on the agent's SOL: daily allowances per wallet and estate, an hourly and daily backstop read from the chain, a balance reserve | [`budget.ts`](../app/src/lib/agent/budget.ts) |
| A lost or compromised agent key can be replaced: by the owner (`set_agent`), or after death by the trusted people's vote (`vote_agent`); the old agent's reviews go back to Pending | Program |

**When the model is wrong:** a wrong Approve still needs the owner (living plan) or a quorum of trusted people and an
objection window (after death) before money moves. A wrong Reject closes that one claim: the child can submit again,
and an agent that keeps getting it wrong can be replaced (by the owner while alive, by the trusted people's vote
after). If the model or the agent wallet is down, nothing is recorded and the item waits: no unreviewed claim is
paid.

## Demo
1. https://heirloom.tumoolo.tech/start: the guided run makes a plan, funds it, claims as the child and shows the agent's
   review as a devnet transaction.
2. Upload the trick fee statement from [docs/demo-documents](demo-documents): the agent rejects the hidden instruction.
3. Open the transaction on Explorer: the agent's signature, the verdict and the document hash.

## Limits
Devnet with a test USD₮ mint only. The model is a hosted model (Gemini). Rand payouts to institutions are simulated.
No third-party audit yet ([internal audit](security-audit.md)).
