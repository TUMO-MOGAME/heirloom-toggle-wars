import type { AskCopy } from "../ask";
import type { AssetsCopy } from "../assets";
import type { AssistantCopy } from "../assistant";
import type { CommonCopy } from "../common";
import type { GuardiansCopy } from "../guardians";
import type { DisputesCopy } from "../disputes";
import type { LandingCopy } from "../landing";
import type { PayCopy } from "../pay";
import type { ScreensCopy } from "../screens";
import type { SiteCopy } from "../site";
import type { TreeCopy } from "../tree";
import type { LettersCopy } from "../letters";
import type { ListenCopy } from "../listen";
import type { VoiceCopy } from "../voice";
import type { ReceiptsCopy } from "../receipts";
import type { LegacyBundleCopy } from "../legacy";
import type { ChipInCopy } from "../chipin";
import type { GuidedCopy } from "../guided";
import type { DeepPartial, Widen } from "@/lib/i18n/merge";

/**
 * One language's copy. English (the files in `src/content/`) is the source of truth:
 * - landing, common UI, payments, the site navigation, guardians and assets must be translated in full,
 *   so a missing key fails `tsc` (and `lib/i18n/merge.test.ts` catches empty slots and missing error names);
 * - screens, the agent sheet and the rest of the site chrome may be partial: whatever is left out
 *   shows in English. Unknown keys still fail `tsc`.
 * Not translated on purpose: amounts, USD₮, the product name, people's and institutions' names, the
 * legal pages, and the suggested chat replies (the on-device demo agent matches them in English).
 */
export interface Bundle {
  /** Ask for money (content/i18n/ask.ts). */
  ask: Widen<AskCopy>;
  /** The Trust Tree (content/i18n/tree.ts). */
  tree: Widen<TreeCopy>;
  /** Letters for later (content/i18n/letters.ts). */
  letters: Widen<LettersCopy>;
  /** Voice typing (content/i18n/listen.ts). */
  listen: Widen<ListenCopy>;
  /** The spoken-language choice on a call (content/i18n/voice.ts). */
  voice: Widen<VoiceCopy>;
  /** Spoken receipts (content/i18n/receipts.ts). */
  receipts: Widen<ReceiptsCopy>;
  /** Legacy Voice (content/i18n/legacy.ts). */
  legacy: Widen<LegacyBundleCopy>;
  /** Chip in (content/i18n/chipin.ts). */
  chipin: Widen<ChipInCopy>;
  /** The guided run (content/i18n/guided.ts). */
  guided: Widen<GuidedCopy>;
  landing: Widen<LandingCopy>;
  common: Widen<CommonCopy>;
  pay: Widen<PayCopy>;
  site: { nav: Widen<SiteCopy["nav"]> } & DeepPartial<Omit<SiteCopy, "nav">>;
  screens: DeepPartial<ScreensCopy>;
  assistant: DeepPartial<AssistantCopy>;
  /** Backups, monitors, objections, succession and the fallback plan. */
  guardians: Widen<GuardiansCopy>;
  /** Assets of any kind: photos, labels, the gallery and the spec sheet. */
  assets: Widen<AssetsCopy>;
  /** Disputes and yearly limits. */
  disputes: Widen<DisputesCopy>;
  /** One line shown above the English-only legal pages. */
  legalNote: string;
}
