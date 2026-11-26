/**
 * Solana Actions (blinks) and Solana Pay response shapes for chip-ins. Pure, so the route stays thin and the tests
 * check the exact shapes. Specs read 25 Nov 2026: Solana Pay SPEC.md (transaction request) and the Actions spec
 * (solana-developers/solana-actions, packages/actions-spec v2.x, and @solana/actions' ACTIONS_CORS_HEADERS).
 *
 * One GET answers both: a Solana Pay wallet reads `label` and `icon`; an Actions client reads `type`, `title`,
 * `description`, `label`, `links.actions` (extra fields are allowed by both specs). One POST answers both too:
 * `{ type: "transaction", transaction, message }`.
 */
import { CHIP_IN_LABEL, CHIP_IN_PRESETS, MAX_CHIP_IN_USDT, chipInApiPath } from "./link";

/** CORS for the Actions routes and /actions.json only (never site-wide): the values the Actions spec requires. */
export const ACTIONS_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
};

/** CAIP-2 chain ids (as in @solana/actions BLOCKCHAIN_IDS). */
export const BLOCKCHAIN_IDS = {
  "mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  testnet: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
} as const;
/** The newest Actions spec version published (SPEC-v2.3.md). */
export const ACTION_VERSION = "2.3";

export function actionHeaders(cluster: string): Record<string, string> {
  const chain = BLOCKCHAIN_IDS[cluster as keyof typeof BLOCKCHAIN_IDS];
  return {
    ...ACTIONS_CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "X-Action-Version": ACTION_VERSION,
    ...(chain ? { "X-Blockchain-Ids": chain } : {}),
  };
}

export interface ChipInGet {
  type: "action";
  /** Solana Pay: the source of the request; Actions: the button text when there are no linked actions. Never a name. */
  label: string;
  icon: string;
  title: string;
  description: string;
  disabled?: boolean;
  error?: { message: string };
  links?: { actions: { type: "transaction"; href: string; label: string; parameters?: { type: "number"; name: string; label: string; required: boolean; min: number; max: number }[] }[] };
}

/**
 * The Actions GET body. `disabled` + `error` when the vault cannot take a chip-in (the blink then shows why);
 * the demo is always disabled. Relative hrefs: an Actions client resolves them against this URL's origin.
 */
export function chipInGet(input: { origin: string; estate: string; cluster: string; problem?: string | null; demo?: boolean }): ChipInGet {
  const api = chipInApiPath(input.estate);
  const test = input.cluster === "mainnet-beta" ? "" : " This runs on Solana devnet with test USD₮: no real money.";
  const base: ChipInGet = {
    type: "action",
    label: CHIP_IN_LABEL,
    icon: new URL("/icons/apple-touch-icon.png", input.origin).toString(),
    title: "Chip in to a family's Heirloom vault",
    description: `Add USD₮ to a family's vault from your own wallet. No account needed. The money goes straight into the vault the family's rules pay from.${test}`,
  };
  if (input.demo || input.problem) {
    return { ...base, disabled: true, error: { message: input.problem ?? "Not available here." } };
  }
  return {
    ...base,
    links: {
      actions: [
        ...CHIP_IN_PRESETS.map((n) => ({ type: "transaction" as const, href: `${api}?amount=${n}`, label: `${n} USD₮` })),
        {
          type: "transaction" as const,
          href: `${api}?amount={amount}`,
          label: "Chip in",
          parameters: [{ type: "number" as const, name: "amount", label: `Amount in USD₮ (up to ${MAX_CHIP_IN_USDT.toLocaleString("en-US")})`, required: true, min: 1, max: MAX_CHIP_IN_USDT }],
        },
      ],
    },
  };
}

/** The Actions / Solana Pay POST body. */
export const chipInPost = (transaction: string, message: string) => ({ type: "transaction" as const, transaction, message });

/** actions.json: the public page /chip-in/<estate> is a blink for /api/chipin/<estate>. */
export const ACTIONS_JSON = { rules: [{ pathPattern: "/chip-in/*", apiPath: "/api/chipin/*" }] } as const;
