/**
 * Letters for later copy (/letters; plan.md §16.10): personal letters from the estate owner that open at the right
 * moment. af/st/zu live in content/i18n/letters.ts and must translate every key (content/letters.test.ts).
 * Text only: no recorded or copied voices anywhere in this copy.
 */
export const letters = {
  meta: { title: "Letters for later" },
  eyebrow: "Family",
  title: "Letters for *later*",
  line: "Your own words for your family, opened at the right moment.",
  demoNote: "Demo: letters stay in this browser. On the live network they are signed by the owner's wallet and kept off-chain.",
  chainNote: "Letters are signed by {owner}'s wallet and never go on the public ledger. Until the family's server store is switched on, a letter is kept on the device that wrote it and on this server.",
  notWill: "This letter is personal. It is not part of your will and does not change who receives what.",
  privacy: "How letters are kept",
  loading: "Loading letters",
  loadError: "Letters could not be loaded.",
  retry: "Try again",

  noRole: {
    title: "Letters are for the family",
    body: "Only the estate's owner and the family members named in the plan can open this page.",
    back: "Back to the estate",
  },
  sealed: "Letters are sealed. Nothing can be added or changed now that the estate has unlocked.",
  paused: "Letters can't be changed while a passing is being confirmed.",

  list: {
    title: "Your letters",
    empty: "No letters yet. Write one for a birthday, a graduation, or for when the plan starts without you.",
    new: "New letter",
    to: "To {name}",
    family: "the whole family",
    familyShort: "Family",
    edit: "Edit",
    delete: "Delete",
    confirmTitle: "Delete this letter?",
    confirmDelete: "It is erased at once and nobody will be able to read it. This can't be undone.",
    confirmCta: "Delete letter",
    cancel: "Keep it",
    deleted: "Letter deleted",
    untitled: "A letter",
    seeded: "Demo letter, added when the demo was set up",
  },

  state: {
    unlock: "Opens when the estate unlocks",
    date: "Opens on {date}",
    payment: "Opens with {name}'s gift, {amount}, due {date}",
    paymentNoDate: "Opens with {name}'s next payment, {amount}",
    /** A claim rule (no set amount): the per-claim limit is not the payment, so no amount is named. */
    paymentNext: "Opens with {name}'s next payment",
    send: "Opens when your transfer is confirmed",
    opened: "Opened {date}",
  },

  editor: {
    titleNew: "New letter",
    titleEdit: "Edit letter",
    to: "Who is it for?",
    family: "The whole family",
    familyHint: "Everyone named in the plan can read it once it opens.",
    person: "One person",
    personHint: "Only they can read it.",
    when: "When does it open?",
    whenUnlock: "When the estate unlocks",
    whenDate: "On a date",
    whenDateHint: "At midnight, South African time.",
    whenPayment: "With a payment from the plan",
    whenPaymentHint: "The letter opens with the next payment under this rule.",
    noRules: "{name} has no payment rule yet. Add one in the plan first.",
    familyNoPayment: "A letter to the whole family opens at unlock or on a date.",
    ruleOption: "{category}: {amount}, next due {date}",
    ruleOptionNoDate: "{category}: up to {amount} a payment",
    about: "About (optional)",
    aboutNone: "Nothing in particular",
    occasion: "Occasion (optional)",
    occasionHint: "For example: For your 18th birthday",
    text: "Your letter",
    counter: "{count} of {max}",
    help: "Help me write it",
    check: "Check my letter",
    checking: "Checking",
    save: "Save and sign",
    saved: "Saved and signed",
    ackWarnings: "I have read the warnings",
    cancel: "Cancel",
    tooLong: "Shorten the letter to {max} characters.",
    empty: "Write something first.",
    dateNeeded: "Choose a date after today.",
    ruleNeeded: "Choose the payment it opens with.",
  },

  help: {
    title: "A suggestion",
    label: "A suggestion. Change it into your own words.",
    points: "A few things you want to say (optional)",
    pointsHint: "Short notes are enough: a memory, a hope, a piece of advice.",
    ask: "Suggest a draft",
    asking: "Writing a suggestion",
    use: "Use this",
    dismiss: "No thanks",
    templates: {
      unlock: "{name},\n\nIf you are reading this, the plan is doing what I asked it to do, and I am not there to do my part.\n\n[A memory you share]\n\n[What you hope for them]\n\nLook after each other.\n\n[Your name]",
      date: "{name},\n\n{occasion}. I wrote this long before today, because I wanted to be part of it.\n\n[A memory you share]\n\n[What you hope for them]\n\n[Your name]",
      payment: "{name},\n\nThis gift comes from a plan I made for you. {occasion}.\n\n[What you hope they will do with it]\n\n[Something that makes them laugh]\n\n[Your name]",
      send: "{name},\n\nI sent you this today. {occasion}.\n\n[Why you are sending it]\n\n[Your name]",
    },
  },

  review: {
    title: "What to check",
    none: "Nothing to warn you about. The words are yours to keep or change.",
    intro: "These are warnings, not rules. You can still save.",
    source: {
      rules: "Checked on this device against Heirloom's rules.",
      ai: "Checked against Heirloom's rules and by the AI agent. The AI only suggests; nothing was saved.",
    },
    codes: {
      "secret.password": "This looks like a password. A letter is not a safe place for one: anyone who reads it later can use it.",
      "secret.pin": "This looks like a PIN or a one-time code. Leave it out of the letter.",
      "secret.seed": "This looks like a wallet recovery phrase. Never write one in a letter: whoever reads it controls the wallet.",
      "secret.card": "This looks like a bank card number. Leave it out of the letter.",
      "secret.account": "This looks like a bank account number. Your executor will have what is needed; leave it out of the letter.",
      "secret.idNumber": "This looks like a South African ID number. Leave it out of the letter.",
      "will.asset": "Your plan sells the {asset} and puts the money in the family vault. This letter says it belongs to {name}.",
      "will.amount": "This letter mentions {amount}, but the gift it opens with is {gift}.",
      "will.other": "This letter says the {asset} belongs to {name}, but your plan gives it to someone else. Check that the letter and the plan agree.",
    },
    familyName: "the family",
  },

  read: {
    title: "Letters for you",
    empty: "No letters for you yet.",
    from: "From {name}",
    opened: "Opened {date}",
    about: "About: {asset}",
    gift: "With {amount}, paid {date}",
    giftSimulated: "simulated",
    proof: "See the payment",
    addedBy: "Added by {name}, {year}",
    transcribedBy: "Written by {name} in {year}, typed out by {owner}",
    signed: "Signed by {name}'s wallet on {date} · {hash}",
    demoSigned: "Demo letter, added when the demo was set up",
    print: "Print",
    printed: "Printed from Heirloom on {date}",
  },

  moment: {
    title: "{name} left you a letter",
    body: "{occasion}",
    cta: "Read it",
  },
  nudge: {
    title: "{name} left you a letter",
    cta: "Read the letter",
  },
  card: {
    letters: "{count} letters from {name}",
    letter: "1 letter from {name}",
    read: "Read",
    imagined: "imagined",
  },
  willCard: {
    title: "Letters for later",
    body: "{count} letters, {gifts} with a gift",
    empty: "Leave a few words for a birthday, a graduation, or for when the plan starts without you.",
    cta: "Open letters",
  },
  send: { add: "Add a letter to this gift" },

  errors: {
    forbidden: "Only the estate owner can write letters.",
    paused: "Letters can't be changed while a passing is being confirmed.",
    sealed: "Letters are sealed now that the estate has unlocked.",
    opened: "This letter has opened, so it can no longer be changed. You can still delete it.",
    version: "This letter was changed somewhere else. Reload and try again.",
    tooLarge: "The letter is too long. Shorten it to 2,000 characters.",
    badLetter: "Something in the letter needs fixing.",
    badLink: "That payment rule is not for this person.",
    full: "An estate can keep 50 letters. Delete one to write another.",
    unavailable: "Letters can't be saved on this server right now. Your letters stay on this device.",
    network: "No connection. Your letters stay on this device; try again when you're online.",
    notFamily: "Only the estate's family can read letters.",
  },

  /** The seeded demo letters (plan.md §16.11), so the demo reads in every language. Written 18 Nov 2026. */
  demo: {
    family: {
      occasion: "For all of you",
      text: "My dear Lerato, Sipho and Naledi,\n\nIf you are reading this, I could not stay as long as I wanted to. I am so sorry. Please don't carry the sadness alone. Carry it together, the way we carried that old couch up the stairs, laughing the whole way.\n\nLook after each other first and the money second. Phone each other on Sundays. Visit Gogo's grave when you can, and ask Uncle Bongani for the stories I never finished telling.\n\nEvery morning I woke up grateful that I got to be your father. Nothing you do will ever make me love you less. I am proud of you today, and I will be proud of you on every day I can't see.\n\nWith all my love, always,\nDad",
    },
    lerato: {
      occasion: "About the Corolla",
      text: "My Lerato,\n\nDo you remember stalling the Corolla at every robot on Klipspruit Valley Road? You cried, then you laughed, then you tried again. That is exactly who you are, and it is why I never worried about you.\n\nThe plan sells the car so the money keeps paying for your studies and for Sipho and Naledi. I know it will hurt to see it go. Keep the photos, not the car. The memories were always the best part.\n\nYou were my first baby, and you made me a father. Be gentle with yourself, and drive carefully, my girl.\n\nLove you to the moon and back,\nDad",
    },
    naledi: {
      occasion: "For your 18th birthday",
      text: "Happy 18th birthday, my Naledi!\n\nYour name means star, and from the night you were born you have lit up every room you walk into. I wish I could be there to embarrass you with a long speech and a cake that is far too big.\n\nThe 500 USD₮ is my gift to you, to start something of your own: a course, a laptop, a first month's rent. Please spend a little of it on something that makes you laugh out loud.\n\nBe brave, be kind, and never let anyone dim your light.\n\nI love you more than all the stars,\nDad",
    },
    mkhulu: {
      occasion: "About Mkhulu Joseph",
      text: "My children,\n\nMkhulu Joseph left no letter, so these are my words, not his. But I knew him, and I know what he would want you to hear.\n\nHe built the house in Soweto with his own hands, brick by brick, after long shifts. Every January he paid for every school book in cash, and he never once complained. He believed in you before you were even born.\n\nWhen you plant something, think of him. When you are tired and want to give up, remember the hands that built that house. His strength is in you.\n\nWith love, from him and from me,\nDad",
    },
  },
};

export type LettersCopy = typeof letters;
/** The seeded demo letters' keys. */
export type DemoLetterKey = keyof LettersCopy["demo"];
