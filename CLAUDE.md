# Heirloom (W3Node hackathon project)

At the start of every session, read `status.md` first, then the parts of `plan.md` you need.
At the end of every session (or after any milestone), update `status.md`: Done, Next up, the Decisions log and Blockers.

- Design and scope: `plan.md`. Change it there when the design changes, and log why in `status.md`.
- Solana toolchain (Rust, Agave CLI, Anchor 1.0, Surfpool) runs inside **WSL2 Ubuntu**; the Next.js app can run on Windows.
- Never put personal documents or personal data on-chain; store only SHA-256 hashes.
- The AI agent (Claude, `claude-opus-5-5`) may only recommend and review; caps, floors and quorums are enforced in the program.
- All UI copy lives in `app/src/content`; use design tokens; write tests for every on-chain check.
- Two live sites move together: the demo (heirloom-one-iota.vercel.app, mock) and devnet (heirloom-devnet.vercel.app, chain). Build every feature in both the mock and the chain service, and after each push check both sites. If one side can't take a change yet (e.g. a program upgrade is waiting on SOL), record it in `status.md`.
