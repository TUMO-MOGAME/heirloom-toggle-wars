import type { HeirloomService } from "./types";
import type { MockService } from "./mock";

/**
 * True for the in-memory demo service. Kept apart from ./mock so the app shell can ask the question without
 * bundling the whole demo (its data, Legacy Book, guardians and schemas) into the first page load.
 */
export function isMockService(s: HeirloomService | null | undefined): s is MockService {
  return !!s && s.mode === "mock" && typeof (s as MockService).setActor === "function";
}

/** Where the demo keeps its simulated estate in this browser (see ./mock). */
export const MOCK_STORE_KEY = "heirloom.mock.v5";

