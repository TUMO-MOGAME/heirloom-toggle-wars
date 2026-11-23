/**
 * "Help me write it" without the AI (the demo, or devnet without a key): a template with blanks for the owner's own
 * words, one per opening kind (content/letters.ts help.templates). An empty occasion drops its sentence cleanly.
 */
import type { LetterOpensKind } from "./types";

export function fillTemplate(templates: Record<LetterOpensKind, string>, kind: LetterOpensKind, name: string, occasion: string): string {
  const o = occasion.trim().replace(/[.!]+$/, "");
  return templates[kind]
    .replace(/\{name\}/g, name)
    .replace(/ ?\{occasion\}\.?/g, o ? ` ${o}.` : "")
    .replace(/^\s+/gm, (m) => m.replace(/ +/g, ""))
    .replace(/ +\n/g, "\n");
}
