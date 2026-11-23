# Heirloom on Solana Mobile: plan

Status: proposal, 15 Nov 2026. Nothing built yet. The decisions marked **[Tumo]** are needed before work starts.

## Goal
Heirloom installs from the Solana dApp Store (on the Seeker and any Android phone) and lets a family sign with the
phone's own wallet, including Seed Vault on the Seeker, while the web app and the Tether WDK wallets keep working.

## What Solana Mobile needs (checked against docs.solanamobile.com, Nov 2026)
- **Store listing:** a web app is published as a PWA wrapped in an Android APK (a Trusted Web Activity), then submitted
  through the dApp Store publishing portal. Listings are NFTs on Solana; the publisher must pass KYC (person) or
  KYB (company) before adding an app. Solana Mobile's docs name two wrappers: Bubblewrap and their newer `webshell`.
  We pick whichever the publishing docs recommend when we start.
- **Domain proof:** the APK's signing-key fingerprint is published at `https://<domain>/.well-known/assetlinks.json`,
  so the TWA opens full-screen without a browser bar.
- **Wallets:** Mobile Wallet Adapter (MWA) for the web is `@solana-mobile/wallet-standard-mobile` (`registerMwa`). It
  connects to Phantom, Solflare and the Seeker's Seed Vault Wallet. "Seeker Connect" (live Oct 2026) adds a one-tap
  "Connect with Seeker" button on top (`@solana-mobile/seeker-connect-wallet-standard`). Testing without a Seeker:
  the Mock MWA Wallet on any Android phone.

## What Heirloom already has
- An installable PWA (manifest, service worker), responsive down to 360 px, a CSP, and two live sites (demo, devnet).
- Every role signs with a Tether WDK wallet kept in the browser (seed encrypted with a PIN). That is the Tether-track
  story and stays the default.

## Plan
1. **Wallet choice in the app (both services).** On Android, "Start" offers "Use my phone wallet" (MWA / Seeker
   Connect) next to "Create a Heirloom wallet" (WDK). Add a `WalletSource` for wallet-standard wallets beside the WDK
   one, so screens don't care which signed. Fee sponsorship still works (the user signs, the sponsor pays). Mock mode
   gets a simulated phone wallet so the demo shows the flow. CSP: allow what MWA needs (a local websocket on Android).
2. **App polish for a phone store.** Manifest: maskable icons, screenshots, `display: standalone`, theme colours;
   offline page; Android back button behaviour; safe-area insets; check every flow by touch at 360–412 px.
3. **APK.** Wrap the chosen site with Bubblewrap or `webshell`; signing key kept OUT of git (like the program keypair);
   `assetlinks.json` served by Next from `public/.well-known/`. Test on an Android phone and the Mock MWA Wallet.
4. **Listing.** Publisher profile + KYC/KYB [Tumo], app name, icon, screenshots, description, privacy policy URL,
   then submit through the portal. The listing NFT is minted on mainnet, which costs a little SOL [Tumo].
5. **Seeker extras (later).** "Connect with Seeker" one-tap button; Seed Vault signing for the owner's will.

## Decisions (Tumo, 15 Nov 2026)
- **Store app = the devnet site** (real transactions on the test network, labelled), so it waits on the devnet upgrade.
- **Domain = heirloom.tumoolo.tech**, pointed at the `heirloom-devnet` Vercel project before the APK is built.
- **Publisher = Tumo as a person** (KYC).
- **Wallets = both:** the Tether WDK wallet stays the default; "Use my phone wallet" (MWA / Seeker Connect) is added.

## Progress
- 15 Nov 2026, branch agent/mobile: steps 1 and 2 built (see status.md, "SOLANA MOBILE STEPS 1-2"). Not yet tested on a phone.
