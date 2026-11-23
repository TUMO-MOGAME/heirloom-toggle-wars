/**
 * The one markup convention in content: a key word of a heading wrapped in asterisks, `"Plan for your *family*"`,
 * gets the hand-drawn amber underline (the `.mark` utility in globals.css). Rendering: components/ui/marked.tsx.
 * Anywhere the text is plain (a page <title>, an aria-label, a toast), use `unmark`.
 */
const MARK = /\*([^*\n]+)\*/g;

export type MarkPart = { text: string; marked: boolean };

/** Splits copy into plain and marked runs. Unpaired asterisks stay as they are. */
export function splitMarks(text: string): MarkPart[] {
  const out: MarkPart[] = [];
  let last = 0;
  for (const m of text.matchAll(MARK)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), marked: false });
    out.push({ text: m[1], marked: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), marked: false });
  return out;
}

/** The copy without its marks, for plain-text uses. */
export function unmark(text: string): string {
  return text.replace(MARK, "$1");
}
