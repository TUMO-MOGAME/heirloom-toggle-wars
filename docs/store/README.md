# Solana dApp Store listing assets

Everything the publisher portal (publish.solanamobile.com) asks for, ready to upload. Build and signing notes are in
[`../android-build.md`](../android-build.md).

| Asset | File | Size |
|---|---|---|
| App icon | [`../../app/public/icons/icon-512.png`](../../app/public/icons/icon-512.png) | 512 × 512 |
| Banner | [`banner.png`](banner.png) (source: `banner.html`, render with `node docs/store/render.mjs <path-to-playwright-core>`) | 1200 × 600 |
| Screenshots | `chat.png`, `estate.png`, `will.png`, `car.png`, `claims.png`, `send.png`, `family.png`, `landing.png` | 1080 × 1920 |

Screenshots are the live app at 360 px (3× scale), night mode, with the demo guide bar hidden because the store app
(the devnet site) doesn't show it. Suggested order: chat, estate, will, car, claims, send.

## Listing text (draft)

**Name:** Heirloom

**Short description (≤ 80 characters):** A living family plan in USD₮: pay school fees now and after you're gone.

**Long description:**

> Heirloom turns what your family needs into a plan that pays itself. Tell it in plain words: books every month,
> university fees paid straight to the university, an allowance for your mother. The plan holds USD₮ in a vault
> owned by a Solana program, not by us, and pays only for its purpose, only to the right place and never above the
> caps you set.
>
> The same rules keep running after you're gone. A death claim needs a document check, two of three trusted people
> and a waiting period you can veto. The car sells at a fair price, never below the floor you set. The AI assistant
> explains, drafts and checks; it can only recommend. Every rule is enforced on-chain.
>
> Wallets are Tether WDK wallets that live on your phone, protected by a PIN, or your own Solana phone wallet.
> This version runs on Solana devnet with test USD₮.

**Category:** Finance · **Privacy policy:** https://heirloom.tumoolo.tech/privacy · **Terms:** https://heirloom.tumoolo.tech/terms

The fonts in this folder (Work Sans, Geist ₮ glyph) are copies of `app/public/fonts`, used only to render the banner.
