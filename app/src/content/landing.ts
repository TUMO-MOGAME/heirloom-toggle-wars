/**
 * Landing page copy.
 * Words between *asterisks* get the hand-drawn underline (the `.mark` class); keep exactly one marked
 * phrase per heading in every language. The problem section's facts are quoted from docs/landing-facts.md:
 * `say` is the exact sentence (read out by screen readers); `value`, `lead` and `rest` are how it is laid out.
 */
export const landing = {
  hero: {
    eyebrow: "A living family plan for South African families",
    title: "Plan for your family, *now* and after you're gone.",
    body: "Tell Heirloom what your family needs, in your own words. It becomes a plan on a secure vault of USD₮: books and term fees paid when due today, and the same rules carrying on after you're gone. Each rule pays only payees you approve, like the university or the residence. What no rule needs goes to the person you name.",
    primary: "Try the demo",
    secondary: "See how it works",
    note: "Works on any phone, in the browser or as an app. No browser extension.",
    photoAlt: "A father kisses his smiling young son on the cheek.",
    receipt: { title: "3 200 USD₮ paid", detail: "to University of Cape Town" },
    card: {
      label: "Example: the Mokoena family estate, active, with 24 000 USD₮ in its vault, paying Lerato's book allowance now, her tuition paid, and the family car to be sold later.",
      title: "Mokoena family estate",
      status: "Active",
      vaultLabel: "Secure vault",
      vault: "24 000 USD₮",
      vaultZar: "≈ R 428 400",
      rows: [
        { label: "Lerato · books", detail: "Every month to Van Schaik", amount: "85 USD₮", state: "Now" },
        { label: "Lerato · tuition", detail: "Straight to UCT", amount: "3 200 USD₮", state: "Paid" },
        { label: "Family car", detail: "Sold at Dad's floor or above, later", amount: "12 500 USD₮", state: "Later" },
      ],
    },
  },
  strip: {
    label: "Built with",
    items: [
      { term: "Tether USD₮", detail: "stable digital dollars" },
      { term: "Tether WDK", detail: "keys on your phone" },
      { term: "Solana", detail: "low-fee payments" },
      { term: "2 of 3", detail: "trusted people confirm a passing" },
    ],
  },
  problem: {
    eyebrow: "The problem",
    title: "Good intentions get lost. And an estate can take *a year* to wind up.",
    body: "When a parent dies, bank accounts freeze while the estate is reported, an executor is appointed and creditors are paid. In that gap, registration is blocked, rent falls behind and the family car is sold in a hurry for far less than it's worth.",
    photoAlt: "A woman holds her head in both hands, overwhelmed.",
    caption: "\"The fees are due on Monday. The estate won't pay out for a year.\"",
    facts: [
      { value: "66%", lead: "of South Africans don't have a will.", rest: "", say: "66% of South Africans don't have a will." },
      { value: "2×", lead: "A simple estate used to take 6–9 months to wind up.", rest: "Now it takes about twice as long.", say: "A simple estate used to take 6–9 months to wind up. Now it takes about twice as long." },
      { value: "2.8m", lead: "South African children have lost a parent;", rest: "64% of them lost their father.", say: "2.8 million South African children have lost a parent; 64% of them lost their father." },
    ],
    sourcesLabel: "Sources:",
    sources: [
      { label: "Sanlam Legacy Wills Survey 2025 via TimesLIVE (19 Sep 2025)", href: "https://www.timeslive.co.za/news/south-africa/2025-09-19-66-of-south-africans-risk-family-feuds-by-dying-without-wills-sanlam-survey/" },
      { label: "Moneyweb via The Citizen (2 Dec 2024)", href: "https://www.citizen.co.za/business/winding-up-of-estates-in-sa-in-shambles" },
      { label: "South African Child Gauge 2024 via Cape Times (22 Aug 2024)", href: "https://capetimes.co.za/news/2024-08-22-mens-high-mortality-rate-leaves-many-children-orphaned" },
    ],
  },
  purposes: {
    eyebrow: "What your plan pays for",
    title: "Every rand has a *purpose*, and a place it goes.",
    body: "Rules are written in plain language and enforced by a contract. Each one pays a payee you approved: the bookstore, the university, the residence or a family member's own wallet if you choose it.",
    items: [
      { tag: "Now · every month", title: "Books and study costs", amount: "85 USD₮", body: "Lerato's book allowance, paid every month.", to: "To Van Schaik Bookstore", alt: "University students working in a lecture room." },
      { tag: "Every term", title: "Tuition, all the way to graduation", amount: "3 200 USD₮", body: "Term fees, today and after you're gone.", to: "To University of Cape Town", alt: "A graduate raises her cap in front of a university building." },
      { tag: "Monthly", title: "A safe place to live", amount: "300 USD₮", body: "Residence rent every month, while the vault covers it.", to: "To Tugwell Residence", alt: "A father holds his daughter's hand as she walks along a wall under a blue sky." },
      { tag: "Later · after you're gone", title: "The family car, sold fairly", amount: "≥ 12 500 USD₮", body: "Not below Dad's floor unless real hardship is proven. A trusted person co-signs.", to: "Back into the family vault", alt: "A silver 2017 Toyota Corolla, seen from the front." },
    ],
  },
  how: {
    eyebrow: "How it works",
    title: "Three steps. *Plain language* throughout.",
    body: "No forms full of legal terms. You talk, Heirloom writes it down, you check it and sign.",
    steps: [
      {
        title: "Say what your family needs",
        body: "Chat or talk with the Heirloom agent, in English, isiZulu, Sesotho or Afrikaans. It writes the plan back in plain language, and you choose which rules start now.",
      },
      {
        title: "Sign and fund the vault",
        body: "Create a wallet on your phone with Tether WDK, sign your plan and deposit USD₮. Setting up needs a little SOL for rent. Rules you marked \"now\" can pay when due: the hosted schedule runs once a day, and anyone can trigger a payment that is due. The rest wait. You can withdraw until a passing is confirmed.",
      },
      {
        title: "The plan outlives you",
        body: "After two of your three trusted people confirm your passing and a waiting period ends, the same plan carries on. The rules keep paying the university directly. The car can sell at or above your floor, with a trusted person co-signing.",
      },
    ],
    chat: {
      label: "Example conversation with the Heirloom agent",
      me: "Thabo",
      agent: "Heirloom",
      ask: "R1 500 a month for Lerato's books. UCT fees every term. Sell my Corolla for no less than R225 000 when I'm gone.",
      reply: "Here's your plan in plain words:",
      plan: [
        "Books: 85 USD₮ monthly to Van Schaik, starting now",
        "Tuition: paid to UCT each term",
        "The Corolla: sold at 12 500 USD₮ or more, later",
      ],
    },
    sign: {
      label: "Example: a vault holding 24 000 USD₮, with books and tuition starting now and the car sale after.",
      vaultLabel: "Your vault",
      vault: "24 000 USD₮",
      vaultZar: "≈ R 428 400",
      now: "Now",
      after: "After",
      rows: [
        { title: "Books for Lerato", detail: "85 USD₮ every month" },
        { title: "UCT tuition", detail: "3 200 USD₮ every term" },
        { title: "Sell the Corolla", detail: "Floor 12 500 USD₮" },
      ],
    },
    timeline: {
      alt: "Silhouette of a father lifting his child onto his shoulders at sunset.",
      items: [
        "Passing confirmed by Adv. Ndlovu and Ms. Pillay",
        "Waiting period: Thabo can still cancel",
        "Plan unlocked. Tuition keeps going to UCT",
      ],
    },
  },
  safety: {
    eyebrow: "Trust and safety",
    title: "The agent advises. The contract enforces. *People you trust* decide.",
    photoAlt: "A baby's hand resting in an adult's open palm.",
    quote: "What you plan today can still work for them when you can't be there.",
    items: [
      { title: "Limits no one can talk past", body: "A Solana program checks caps, approved payees and the price limits, so the AI agent can't move money outside them. Heirloom holds the key that can upgrade the program." },
      { title: "Two of three trusted people", body: "Your executor, a lawyer, a family elder. Two of them confirm a passing. If only one who may decide is left, that one decides. If none is left, the fallback list you set takes over after a long wait." },
      { title: "\"I'm still here\"", body: "A waiting period follows every confirmed passing. One tap from you at any time before it unlocks cancels the report." },
      { title: "Hardship, handled with care", body: "A sworn affidavit and your trusted people's agreement can let the car sell below your price, but never below your hardship floor." },
      { title: "Private papers stay private", body: "Death certificates and IDs never go on a public ledger. Only a fingerprint of each document does, so anyone can check nothing was altered." },
      { title: "Your keys, on your phone", body: "Wallets are created with Tether WDK and the recovery phrase stays on your device. Heirloom's servers never hold your keys." },
    ],
  },
  proof: {
    eyebrow: "Proof, one tap away",
    title: "Every payment has a *receipt* anyone can check.",
    body: "Heirloom keeps the technology out of your way and the evidence within reach. Every deposit, approval and payment can be opened on Solana Explorer.",
    points: [
      { term: "USD₮", detail: "The only money the vault accepts. The contract rejects look-alike tokens." },
      { term: "Tether WDK", detail: "Wallets made in the app, and the agent's own, use the Wallet Development Kit. You can also bring a phone wallet." },
      { term: "Solana", detail: "Low fees make small, purpose-by-purpose payouts practical." },
      { term: "Rand", detail: "Amounts are shown in rand at a live South African exchange rate." },
    ],
    receipts: {
      title: "Mokoena family · receipts",
      network: "Solana devnet",
      /** Read after each transaction link by screen readers. */
      open: "open on Solana Explorer",
      /** Same order as `receiptTxs` below: what each real devnet transaction did. */
      rows: [
        { title: "School fees paid", detail: "Naledi · approved claim", amount: "350 USD₮" },
        { title: "Yearly limit set", detail: "Naledi's school fees", amount: "3 000 USD₮" },
        { title: "Corolla title registered", detail: "Floor in the contract", amount: "12 500 USD₮" },
        { title: "Estate and will signed", detail: "Thabo", amount: "" },
      ],
    },
    honest: "Honest limits: this is a prototype on a test network. It sits beside a signed, witnessed will under the Wills Act and does not replace one. Heirloom holds the program's upgrade key. The program checks a sale's price limit, exact amount and co-signature; which offer ranks best is the agent's advice. The car's digital title gates the handover; eNaTIS registration remains the legal record.",
  },
  cta: {
    eyebrow: "Try it in three minutes",
    title: "See a whole family story, *start to finish.*",
    body: "Step into the demo as Thabo, a father of three from Soweto. Build his family plan, watch the first payment go out, then switch to his children, his trusted people and a car buyer to see the rules hold after he's gone.",
    primary: "Try the demo",
    secondary: "Create my own wallet",
    photoAlt: "A father holds his daughter's hand as she walks along a wall under a blue sky.",
    card: { title: "Still holding her hand", body: "The plan keeps to its rules, even when you can't be there." },
  },
} as const;

export type LandingCopy = typeof landing;

/**
 * The receipts card's transactions (not translated): the devnet demo estate 2LXv…ymP7, seeded 15 Nov 2026
 * (status.md, "DEVNET RE-SEED"). Same order as `landing.proof.receipts.rows`.
 */
export const receiptTxs = [
  "4zCVXHoaGoC9CsdeWaQd7DgZDSMs1xmBtww6MGzVGE1gPTijjBbDKycyR51wxxJDbcprpfyHGzayXvvBpuxXbskw",
  "5aG6cTDQUYebJxR7w9V242zoYXLWMbgdahr8X1V9gGRmpbZoxVM9aKQH8kxtUyLzQSoe7Sy3jMxqoe5Yede6ifZV",
  "5oTTsNKYdcS8kfb9Dd4B9MRovpAGHgnmBS2xUPSWZbELxgfjuvWrkNCSNomRe9TNxrfLoENy1hcVW4TEbk2J5mfs",
  "5jJvf8RqqDpokwtmA6Mopsgb1Kv7xjgk6d9MpYWjwjsSsevGjYzXPxxD9wYKgVni5P3mZEmtAyx4C3cAFb6vgRp2",
] as const;
