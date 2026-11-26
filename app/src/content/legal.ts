/** Privacy policy (POPIA template) and terms. Both are marked as templates for legal review. */
export interface LegalSection {
  /** An anchor for links into the policy (/privacy#letters). */
  id?: string;
  heading: string;
  paragraphs?: readonly string[];
  list?: readonly string[];
}

export const privacy = {
  title: "*Privacy* policy",
  templateNotice:
    "Template for legal review. This policy was drafted for a hackathon prototype and must be reviewed by the responsible party's legal adviser before Heirloom is offered to the public.",
  updated: "Last updated: 26 November 2026",
  intro:
    "Heirloom helps a person record estate instructions and helps their family act on them. That involves sensitive personal information, so we collect as little as we can, keep documents off the public ledger and explain every use below. This policy follows the Protection of Personal Information Act 4 of 2013 (POPIA).",
  sections: [
    {
      heading: "1. Responsible party",
      paragraphs: [
        "The responsible party is [Legal name], [legal status], registration number: not registered, of [physical address]. Contact: [email address], [phone number].",
      ],
    },
    {
      heading: "2. Information officer",
      paragraphs: [
        "Information officer: [Full name], [email address], [phone number]. You can contact the information officer about anything in this policy or to exercise your rights.",
      ],
    },
    {
      heading: "3. What we collect and why",
      list: [
        "Names and relationships of the estate owner, family members and trusted people: to write the rules and show each person what they may do.",
        "Wallet addresses: to identify who may sign which instruction. Wallet recovery phrases and PINs stay on your device and are never sent to us.",
        "Documents you upload (death certificate, fee statements, enrolment letters, leases, affidavits, vehicle registration papers): so the AI agent and your trusted people can check a request before money moves.",
        "What you type or say to the Heirloom agent, including voice call audio and transcripts when you choose a voice call: to draft your rules and answer your questions.",
        "Voice typing: when you tap the microphone in a chat box, a recording of up to a minute is sent, after you tap it again, to turn your words into text in that box. You read and edit the words before anything is sent; nothing is sent or signed by voice. Neither the recording nor the text is stored or logged by Heirloom.",
        "Vehicle details (make, model, year, mileage): to suggest a fair asking price.",
        "The written reason for a dispute or an objection: so the people who decide it can read why. Only its SHA-256 fingerprint goes on-chain; the words are kept off-chain for the estate's members, and on the writer's device.",
        "Letters for later that an estate owner writes to their family (the text, occasion, who it is for and when it opens): to deliver the owner's own words at the moment they chose (section 15).",
        "Your IP address and basic request details: for spam and abuse checks and rate limiting on forms and agent requests.",
        "On the test network, a request for starter funds (your wallet address and IP address): to give test money once per wallet and to limit abuse. The transfer is public and permanent on the ledger, with a note (memo) that holds the time, the cost, a short hash of your wallet address and a code that proves Heirloom sent it. The memo never holds your IP address or anything made from it.",
        "On your device: the owner's browser keeps a copy of the names in their estate, so they can be put back if the server loses them, and a copy of the plan they signed (its people, rules and assets), so an interrupted signing can be finished; devices that named a backup, monitor or payee keep those names. Each copy stays after you sign out. Clearing this site's data in the browser removes them (it also removes any wallet kept there, so save the recovery phrase first).",
        "A test of the plan builder (the demo site only, while the test runs): we are testing which version of the plan builder's first screen helps people start their plan. The app keeps a random, anonymous id in this browser's local storage and sends it to Flagsmith (section 7) with which version of the plan builder you were shown and the names of four steps when you take them (first message, message, reviewed, signed), with numbers only as values. It never sends your name, wallet address, email address or anything you type in the chat. Clearing this site's data in the browser removes the id; the next visit gets a new one.",
        "We set no cookies for tracking, and the test above uses none. Apart from it, this build has no visitor-statistics tool. If statistics are added, they will be cookie-free and this policy will say so first.",
      ],
    },
    {
      heading: "4. Lawful basis",
      paragraphs: [
        "We process personal information with your consent, given through an unticked box on each form, and where it is necessary to carry out the instructions you or the estate owner have recorded. Information about a deceased person and about children is processed only for the purposes above. You may withdraw consent at any time; this does not undo payments already made.",
      ],
    },
    {
      heading: "5. What goes on the public ledger",
      paragraphs: [
        "The Solana ledger is public and permanent. The app writes wallet addresses, amounts, times, rule limits and categories, decisions and votes, roles (for example \"Family member 1\" or \"Approved payee\"), the names typed for universities and schools, SHA-256 fingerprints (hashes) of documents and reports, and the starter memo in section 3. It does not write ID numbers or document contents, or family members' names.",
        "Two things limit that. A name typed as a university or school payee is published as typed, so don't put a person's name there. Test estates made before 22 November 2026 have name labels on-chain (the seeded demo families' fictional names and test runs), and those can't be removed. Wallet addresses and the pattern of payments may also let someone work out who is involved.",
        "Family names, reports and notes are kept off-chain. The app shows reports and notes to that estate's members, who prove it with their wallet's signature. A fingerprint cannot be turned back into the document.",
      ],
    },
    {
      heading: "6. How long we keep it",
      paragraphs: [
        "This says what the service does today. Nothing is deleted on a schedule yet: there is no automatic deletion. The responsible party must set retention periods with its legal adviser before Heirloom is offered to the public.",
      ],
      list: [
        "Uploaded documents and agent reports: where database storage is switched on (section 7), they are kept there until deleted on request. Where it is not, the document itself is not kept after the agent reads it, and reports stay only in the server's temporary memory.",
        "Agent conversations and voice transcripts: kept only where database storage is switched on, until deleted on request.",
        "Voice typing recordings: not kept. The recording is passed straight to the speech-to-text operator (section 7) and dropped when the text comes back; the text only goes where you send it.",
        "Dispute and objection reasons: with the estate's other records, as above.",
        "Letters for later: while the estate's records are kept. The owner can delete any letter while alive and its text is erased at once; see section 15.",
        "The plan-builder test (section 3): the random id in your browser stays until you clear this site's data. Flagsmith keeps the id, the version shown and the four step names under its own terms for as long as the test and its results need them. [Placeholder: the responsible party must set this period with its legal adviser and Flagsmith.]",
        "IP addresses used for spam checks: in the server's temporary memory for the length of each limit (up to a day), or in the shared limit store for that time where it is switched on.",
        "On-chain records: permanent, by the nature of a public ledger (they contain no personal documents).",
        "The copies on your device: until you clear this site's data in that browser.",
        "Where database storage is not switched on, what the server holds (names, reports, letters, reasons) is in temporary memory and is lost when it restarts.",
      ],
    },
    {
      heading: "7. Operators who process information for us",
      list: [
        "Hosting: Vercel Inc. (application hosting and delivery).",
        "Database and document storage, only where it is switched on for the site you are using: Supabase Inc., with data stored in Ireland (encrypted at rest; the app limits access to the people named on an estate), including letters for later. Where it is not switched on, Supabase receives nothing: the server keeps this information in temporary memory and some of it also stays on your device.",
        "AI document review and drafting: Google LLC (Gemini API). Documents are sent for analysis and are not used by us to train models. A letter for later is sent only when its owner taps \"Check my letter\" or \"Help me write it\".",
        "Voice calls with the agent: ElevenLabs Inc. (speech recognition and speech synthesis for calls you start).",
        "Voice typing: ElevenLabs Inc. (Speech to Text) turns a recording you make with the microphone in a chat box into text. Heirloom does not store the recording; ElevenLabs processes it under its own retention terms, in the United States and the European Union (section 8).",
        "Testing the plan builder, on the demo site only: Bullet Train Limited, trading as Flagsmith (a company registered in England and Wales, number 12353266). It receives a random anonymous id, which version of the plan builder was shown and the names of four steps (first message, message, reviewed, signed) with numbers only as values, and uses them to tell us which version helps people start a plan. It never receives names, wallet addresses, email addresses or chat text, and it sets no cookies. Flagsmith runs on Amazon Web Services: under its terms the data is processed in the United Kingdom, and its feature-flag service answers each request from the nearest of its regions (in the United States, the European Union, the United Kingdom, Australia, Brazil, India, Singapore and South Korea).",
        "Exchange rate: a South African exchange's public price feed. No personal information is sent.",
        "Solana public ledger: stores hashes, addresses and amounts only, as described in section 5.",
      ],
    },
    {
      heading: "8. Transfers outside South Africa",
      paragraphs: [
        "Our operators store and process information on servers outside South Africa, including in the United States and the European Union. Where Supabase storage is switched on, the stored names, documents, reports and letters are transferred to and kept in Ireland. On the demo site, the plan-builder test's anonymous id, version and step names go to Flagsmith in the United Kingdom, and its requests may be answered from another of its regions (section 7). The public ledger is copied worldwide. We rely on your consent and on operator agreements that require protection substantially similar to POPIA, as section 72 requires.",
      ],
    },
    {
      heading: "9. Security",
      paragraphs: [
        "Connections use HTTPS. Documents are stored off-chain with access controls. Wallet keys are generated and kept on your device by Tether WDK. No system is perfectly secure; if a breach affects your information we will notify you and the Information Regulator as POPIA requires.",
      ],
    },
    {
      heading: "10. Your rights",
      list: [
        "Ask whether we hold information about you and request a copy.",
        "Ask us to correct or delete information that is inaccurate, out of date or no longer needed.",
        "Object to processing or withdraw consent.",
        "Not be subject to a decision based solely on automated processing: the AI agent can't approve a payment or an exception, which takes people, and people confirm a passing. The one exception: when none of the trusted people is left, the fallback plan can run on the agent's review of the owner's death after a long wait, which can be objected to (see the terms, section 4). The agent can turn down a document it doesn't accept, and you can ask the information officer (section 2) to have a person look at that.",
        "Complain to the Information Regulator.",
      ],
    },
    {
      heading: "11. The Information Regulator",
      paragraphs: [
        "Information Regulator (South Africa), JD House, 27 Stiemens Street, Braamfontein, Johannesburg, 2001. Complaints: POPIAComplaints@inforegulator.org.za. General enquiries: enquiries@inforegulator.org.za. Website: inforegulator.org.za.",
      ],
    },
    {
      heading: "12. Changes",
      paragraphs: ["We will post any change to this policy on this page and update the date above."],
    },
    {
      heading: "13. Legacy voice (optional)",
      paragraphs: [
        "An estate owner may choose to create an AI copy of their own voice and write a Legacy Book (values, guidance for each child and messages for moments such as fees being paid or a graduation). After the owner passes away, each child may choose to hear the owner's messages in the owner's own words, in the owner's voice. This section is part of the template for legal review.",
        "Our rule: the voice only ever says words its owner wrote or approved while alive. It plays the messages the owner wrote in the Legacy Book. It does not hold conversations, answer questions or take calls, and no AI writes new words in the owner's voice after their death.",
        "Who may create it: only the estate owner, while alive, from recordings of their own voice made in the app. They first read a consent sentence out loud and tick an unticked consent box. Recordings of anyone else, or of a person who has died, are not accepted.",
      ],
      list: [
        "What we collect: the recorded consent sentence, three to eight short voice recordings, the voice copy made from them, the Legacy Book text, each child's on/off choice, and the audio of the owner's messages once the voice has read them.",
        "Why: to let the owner's children hear the messages the owner left for them, in the owner's voice, clearly labelled as an AI voice. Before a message plays, the app says it is an AI copy of the owner's voice. The voice cannot approve claims, move money or ask anyone for money or passwords.",
        "Children's information: a child only switches the voice on and plays messages; there is nothing to type to it, so we do not collect what a child says. The child's page always offers South African helplines (SADAG) and suggests a trusted adult.",
        "Operator: ElevenLabs Inc. creates and hosts the voice copy (Instant Voice Cloning) and turns the owner's written messages into speech in that voice. Where storage is switched on (section 7), Supabase Inc. stores the recordings and the Legacy Book in private, access-controlled storage.",
        "Messages in another language: the owner may add a version of a message in another language. If the owner taps \"Suggest a translation\", that one message is sent to the AI operator (Google LLC, Gemini API, section 7) to suggest a faithful translation of the owner's own words; nothing is kept until the owner has read, edited and approved it while alive. Only approved versions are ever read in the owner's voice.",
        "Transfer outside South Africa: ElevenLabs processes this information outside South Africa, including in the United States and the European Union, under the safeguards in section 8.",
        "How long we keep it: until the owner deletes the voice or the Legacy Book, which they can do at any time in the app (the voice copy is then also deleted at ElevenLabs), or [N] years after the estate's final payment, whichever comes first. [Placeholder: the responsible party must set N with its legal adviser.]",
        "Nothing about the legacy voice is written on the public ledger. If a record is ever anchored on-chain, it is only a SHA-256 fingerprint.",
        "Your rights in section 10 apply. A child can switch the legacy voice off at any time, and the owner's executor may ask us to delete it.",
      ],
    },
    {
      heading: "14. Trust Tree (family relationships, years and photos)",
      paragraphs: [
        "The Trust Tree is a family map: who is related to whom, who trusted whom in an estate plan, and the promises they kept. This section is part of the template for legal review.",
      ],
      list: [
        "What we collect: family relationships an estate owner adds (parent of, spouse of, sibling of), people's names as the family gives them, the year each person was born and the year they passed, and whether a person chose to hide from the tree. Roles, approvals and payments come from the public ledger, as in section 5; the tree never shows amounts, balances, prices or scores.",
        "Why: to show the family a lasting, checkable record of who was trusted and whether they kept their word, and to make a false claim about an asset easy to disprove.",
        "Who sees it: only wallets with a role in that estate (the owner, family members, trusted people, guardians and watchers). Buyers and the public record do not see it. For children only a first name is shown.",
        "Who may add it: the estate owner, who confirms with an unticked box that they are entitled to share it. Relationships, names and years are kept off-chain and are never written to the public ledger; only a SHA-256 fingerprint of the tree (wallets, relationships and trust lines, never names) is shown.",
        "Hiding: a living adult can hide themselves at any time from their own card. They then show as \"A family member\" with no name or details; their roles stay, because roles are public on the ledger.",
        "How long we keep it: for as long as the estate is active and for 5 years after its last payment, unless deleted sooner. [Placeholder: the responsible party must confirm this with its legal adviser.]",
        "Deletion and correction: the owner can remove a relationship at any time, and anyone on the tree may ask the information officer (section 2) to correct or delete information about them, as section 10 describes.",
        "Photos: a small photo may be shown beside a person's name on the tree (on the map, the family list, their card and a printed copy), so the family recognises faces in years to come. What we keep is one 256 by 256 pixel image of at most 60 KB per person, prepared on the person's own device: it is cropped, shrunk and re-encoded there, which removes the camera details and location (EXIF) before anything is sent. Photos are never written to the public ledger and are not part of the tree's fingerprint. Who sees them: the same people who can see the tree. Consent: a living adult adds, changes or removes only their own photo (trusted people and lawyers included). The estate owner decides for a child, and may add a memorial photo of someone who has passed or who has no wallet (shown as \"Added by\" with their name and the year), and an organisation's logo. A person who chose to hide never shows a photo. Deletion: the person (or, for a child, someone who has passed or an organisation, the owner) can remove a photo at any time from the card, and anyone may ask the information officer (section 2) to delete a photo of them. In the demo, photos stay on this device, and the demo family's pictures are drawn illustrations, not real people.",
        "Operators and transfers: where storage is switched on, relationships, names and photos are stored by Supabase Inc. in Ireland (otherwise in server memory or on the owner's device) under sections 7 and 8.",
      ],
    },
    {
      id: "letters",
      heading: "15. Letters for later",
      paragraphs: [
        "An estate owner can write short personal letters for their family that open later: when the estate unlocks, on a date (for example an 18th birthday), or with a payment from the plan. This section is part of the template for legal review.",
      ],
      list: [
        "What we collect: each letter's text, its occasion, who it is for (one family member or the whole family), when it opens (the unlock, a date, the payment rule or transfer it is linked to), the author's wallet address, the wallet's signature of the letter and the times it was written, changed and opened.",
        "Why: to deliver the owner's own words at the moment they chose. A letter is personal; it is not part of the will and does not change who receives what.",
        "Who can read it: the author at any time; once it opens, the person it is for, or, for a family letter, the family members named in the estate's plan. Nobody else sees the text, and nobody is told that a locked letter is waiting. Heirloom's operators can access stored letters only to run the service.",
        "Never on the public ledger: no letter, and not even a fingerprint of one, is written on-chain.",
        "Consent and children: the estate owner writes the letters. A letter to a child is read with the child's own wallet once it opens. \"Check my letter\" warns the owner against writing passwords, PINs, recovery phrases, ID numbers or bank details in a letter.",
        "The AI check: \"Check my letter\" and \"Help me write it\" send the draft to the AI operator (Google LLC, Gemini API, section 7) only when the owner taps them; the AI only warns or suggests, and Heirloom does not keep that copy. The same checks also run on the owner's device without the AI.",
        "How long we keep it: while the estate's records are kept (section 6). The owner can delete any letter while alive, and its text is erased at once. After the estate unlocks, letters are sealed and can no longer be changed; a person a letter is addressed to may ask the information officer (section 2) to delete it.",
        "Storage and transfers: where storage is switched on, letters are stored by Supabase Inc. in Ireland under sections 7 and 8 (until then, a letter is kept in server memory and on the device that wrote it). The server can read stored letters; encrypting each letter so only its recipient can read it is planned.",
        "In the demo: letters stay in this browser, and the demo family's letters are fictional.",
      ],
    },
  ] satisfies LegalSection[],
} as const;

export const terms = {
  title: "*Terms* of use",
  templateNotice:
    "Template for legal review. These terms describe a hackathon prototype and must be reviewed by a legal adviser before public use.",
  updated: "Last updated: 22 November 2026",
  intro:
    "Please read these terms before using Heirloom. By creating a wallet or using the demo you agree to them.",
  sections: [
    {
      heading: "1. What Heirloom is, and is not",
      paragraphs: [
        "Heirloom is a prototype tool for recording estate instructions and carrying them out through a program on the Solana network. It is not a will. Under the Wills Act 7 of 1953 a will must be signed and witnessed on paper, and electronic wills are not currently valid in South Africa. Use Heirloom alongside a valid will that names your executor, and take legal advice.",
      ],
    },
    {
      heading: "2. Prototype status",
      paragraphs: [
        "Heirloom runs on a test network (Solana devnet) with test tokens. The program has not been audited. Do not rely on it for real assets. The demo personas, institutions' wallets and rand settlements shown in the app are simulated.",
        "Heirloom holds the program's upgrade key, so it can change the rules the program enforces. While a passing is confirmed or the estate is unlocked, the program itself lets nobody edit a plan's rules.",
        "Payments aren't guaranteed to happen on time or by themselves. The hosted schedule runs once a day and may miss one; anyone can trigger a payment that is due, and it pays only if the vault holds enough. Rules pay approved payees. What no rule needs, the fallback plan and sale money can also go to the people the owner named or who receive it under an approved hardship.",
        "Network fees are sponsored when the sponsor is available. Creating accounts needs a little SOL for rent.",
        "Some situations can't be resolved in the program: a sole remaining trusted person can't approve their own claim, some votes can't be taken back, and money can only be recovered while at least one working path is left (trusted people, or a fallback plan). An estate with neither can be left with money nobody can move.",
      ],
    },
    {
      heading: "3. Your wallet",
      paragraphs: [
        "Wallets are self-custodial. Your recovery phrase is shown once and stays on your device. We cannot recover it for you. Anyone who has the phrase controls the wallet.",
      ],
    },
    {
      heading: "4. The AI agent",
      paragraphs: [
        "The agent drafts rules, reads documents, turns down documents it doesn't accept and suggests prices. It can be wrong. It cannot move money beyond the limits in the program. People you name confirm a passing and any exception; if none of them is left, the fallback plan can run on the agent's review of the owner's death after a long wait, which can be objected to. In a sale the program checks the price limit, the exact amount and a trusted person's co-signature (none is needed when no trusted person is left and the listing has ended); which offer is best is the agent's advice. Nothing the agent says is legal, tax or financial advice.",
      ],
    },
    {
      heading: "5. Vehicles",
      paragraphs: [
        "The car's digital title controls the handover inside Heirloom. Legal ownership in South Africa is the eNaTIS registration, and the executor must complete the change of ownership.",
      ],
    },
    {
      heading: "6. Acceptable use",
      list: [
        "Do not upload documents you have no right to share.",
        "Do not submit false reports of a passing or false claims. Doing so may be a criminal offence.",
        "Do not attempt to interfere with the service or other users' estates.",
      ],
    },
    {
      heading: "7. Liability",
      paragraphs: [
        "To the extent the law allows, the prototype is provided as is, without warranties, and we are not liable for losses arising from its use. Nothing in these terms limits rights you have under the Consumer Protection Act or the Electronic Communications and Transactions Act.",
      ],
    },
    {
      heading: "8. Governing law",
      paragraphs: ["These terms are governed by the law of the Republic of South Africa."],
    },
  ] satisfies LegalSection[],
} as const;
