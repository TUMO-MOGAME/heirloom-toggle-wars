/**
 * Trust Tree copy (/tree; plan.md §15): the family's record of kept promises.
 * af/st/zu live in content/i18n/tree.ts and must translate every key (content/tree.test.ts).
 * No amounts, balances, prices or scores anywhere in this copy: the tree only states facts.
 */
export const tree = {
  metaTitle: "Trust Tree",
  eyebrow: "Family",
  title: "Trust *Tree*",
  line: "The family's record of kept promises",
  demoNote: "Demo story: the years after {today} are imagined.",
  chainNote: "History so far, from the Solana test network.",
  partial: "Older history may load slowly: the test network gave part of it in time, so some early promises may be missing.",
  refresh: "Load again",
  loading: "Loading the Trust Tree",
  loadError: "The Trust Tree could not be loaded.",
  retry: "Try again",

  /** Buyers and visitors without a role in the estate. */
  noRole: {
    title: "The Trust Tree is for the family",
    body: "Only the people named in this estate's plan (the owner, family members, trusted people, guardians and watchers) can see the family's Trust Tree. A buyer sees the car and the offer, not the family.",
    back: "Back to the estate",
  },

  timeline: {
    label: "Year on the tree",
    year: "Year",
    play: "Play the story",
    pause: "Pause",
    today: "Today",
    imagined: "Imagined",
    imaginedYear: "{year}, imagined",
    hint: "Use the arrow keys to move a year at a time.",
    yearStatus: "Showing {year}",
  },

  map: {
    label: "Trust Tree map for {year}",
    generation: "Generation {n}",
    outside: "Trusted outside the family",
    legend: "Trust lines",
    legendNote: "A line grows thicker with each promise kept.",
    relationships: "Family lines",
    passedMark: "Passed",
    org: "Organisation",
    open: "Open {name}'s card",
    empty: "Nobody is on the tree in {year} yet. Move the slider forward.",
    travel: "{asset} passes to {name}",
  },

  list: {
    label: "Family by generation, {year}",
  },

  person: {
    hidden: "A family member",
    hiddenBody: "This person chose not to be shown by name. Their roles stay on the tree because roles are public on-chain.",
    minorBody: "Only a first name is shown for children.",
    born: "Born {year}",
    years: "{from}–{to}",
    passed: "Passed {year}",
    trusted: { one: "Trusted by 1 person", many: "Trusted by {n} people" },
    kept: { none: "No promises recorded yet", one: "Kept 1 promise", many: "Kept {n} promises" },
    you: "You",
    ownPlan: "Has their own Heirloom plan",
  },

  card: {
    close: "Close",
    roles: "Roles",
    rolesEmpty: "No roles in a plan yet.",
    promises: "Kept promises",
    promisesEmpty: "Nothing recorded yet.",
    assets: "Received",
    assetsEmpty: "Nothing received through a plan yet.",
    proof: "Proof",
    proofSr: "Opens Solana Explorer in a new tab",
    simulated: "simulated",
    imagined: "Imagined",
    hide: "Hide me from the tree",
    show: "Show me on the tree again",
    hideNote: "Your name is replaced by \"A family member\" for everyone. Your roles stay, because they are public on-chain.",
    hidden: "You are hidden from the tree",
    shown: "You are shown on the tree again",
  },

  /** Photos (plan.md §15.11): off-chain, family only, never in the fingerprint. */
  photo: {
    add: "Add photo",
    change: "Change photo",
    remove: "Remove photo",
    choose: "Choose a photo for {name}",
    working: "Preparing the photo",
    saved: "Photo saved",
    removed: "Photo removed",
    memorial: "Added by {name}, {year}",
    ownNote: "Only you can add or change your photo. It is kept off-chain, only the family sees it, and you can remove it at any time.",
    ownerNote: "As the estate owner you may add a photo for a child, someone who has passed or an organisation. Only add a photo you are entitled to share.",
    errors: {
      notImage: "That file is not a photo. Choose a JPEG, PNG, WebP or HEIC image.",
      unreadable: "That photo could not be opened. Try another one.",
      tooLarge: "That photo is too detailed to fit in 60 KB. Try a simpler or closer photo.",
      noWebp: "This browser cannot prepare photos. Try a current Chrome, Edge, Firefox or Safari.",
    },
  },

  /** "{role} in {owner}'s plan, {years}". */
  roleTerm: "{role} in {owner}'s plan, {years}",
  since: "since {year}",
  and: "and",

  roles: {
    trustedPerson: "Trusted person",
    guardian: "Guardian",
    heir: "Heir",
    beneficiary: "Beneficiary",
    successor: "Backup guardian",
    monitor: "Watcher",
    fallback: "Fallback recipient",
  },

  relationships: {
    parentOf: "Parent of",
    spouseOf: "Spouse of",
    siblingOf: "Sibling of",
  },

  /** Plain words for each kept promise. {for} is a list of names, {about} one name, {years} "2026" or "2026–2029". */
  kept: {
    confirmedPassing: "Confirmed {about}'s passing, {years}",
    withOther: "with 1 other",
    withOthers: "with {n} others",
    approvedPayments: { one: "Approved 1 payment for {for}, {years}", many: "Approved {n} payments for {for}, {years}" },
    answeredRequests: { one: "Answered 1 request from {for}, {years}", many: "Answered {n} requests from {for}, {years}" },
    planPaid: "{purpose} for {for}, {years}",
    helpedHardship: "Helped {for} through a hard time, {years}",
    guardianTerm: "Guardian of {for}, {years}",
    carriedOutFallback: "Carried out {about}'s fallback plan, {years}",
    raisedUpheldChallenge: "Raised a challenge that was upheld, {years}",
    challengeUpheld: "A challenge against one of their claims was upheld, {years}",
  },

  /** The rule purposes (a Category) as words in a sentence. */
  purposes: {
    Tuition: "School and university fees",
    Accommodation: "A place to live",
    Books: "Books",
    Medical: "Medical care",
    General: "Everyday needs",
  },

  assetKinds: {
    Car: "A car",
    Motorbike: "A motorbike",
    Furniture: "Furniture",
    Jewellery: "Jewellery",
    Electronics: "Electronics",
    Other: "Something else",
  },

  paths: {
    title: "What passed through the family",
    body: "Each thing by kind and name only, with the plan that held it and who it passed to. Never a value or a price.",
    empty: "Nothing registered in a plan by {year}.",
  },

  assetSteps: {
    registered: "Registered in {owner}'s plan, {year}",
    heldByPlan: "Held by {owner}'s plan, {year}",
    passedTo: "Passed to {to}, {year}",
    soldUnderRules: "Sold under the plan's rules, {year}",
  },

  owner: {
    title: "Owner tools",
    add: "Add a relationship",
    sheetTitle: "Add a relationship",
    sheetBody: "Relationships are kept off-chain, as names are personal information.",
    from: "Person",
    kind: "Relationship",
    to: "Person",
    pick: "Choose a person",
    preview: "{from} is the {kind} {to}.",
    kinds: { parentOf: "parent of", spouseOf: "spouse of", siblingOf: "sibling of" },
    same: "Choose two different people.",
    save: "Add to the tree",
    saved: "Relationship added",
    cancel: "Cancel",
    yours: "Relationships you added",
    yoursEmpty: "You have not added any relationships yet.",
    remove: "Remove",
    removeLabel: "Remove: {text}",
    removed: "Relationship removed",
    consentNote: "Only add what you're entitled to share. Living adults can hide themselves.",
    consent: { before: "I am entitled to share this, and I have read the", link: "privacy policy", after: "." },
  },

  footer: {
    fingerprint: "Tree fingerprint",
    fingerprintNote: "A SHA-256 of the tree's wallets, relationships and trust lines (never names), so a printed copy can be checked later.",
    copy: "Copy the fingerprint",
    copied: "Fingerprint copied",
    legal: "This is a family record, not a legal title. An executor and the court have the final word.",
    print: "Print",
    printed: "Printed {date}",
  },
} as const;

export type TreeCopy = typeof tree;
