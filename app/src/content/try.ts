/**
 * /try (plan §4, C5): the short link to share. It opens the demo as a new owner with no plan, straight on the plan
 * builder (/will). The page shows this only for the moment it takes to get there, or when JavaScript is off.
 */
export const tryDemo = {
  metaTitle: "Try the plan builder",
  metaDescription: "Open the Heirloom demo as a new owner with no plan yet, straight on the plan builder. Simulated: nothing real moves.",
  opening: "Opening the plan builder…",
  body: "You're a new owner in the demo, with no plan yet. Nothing real moves.",
  cta: "Open the plan builder",
} as const;

export type TryCopy = typeof tryDemo;
