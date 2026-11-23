import { Fragment } from "react";
import { splitMarks } from "@/lib/marked";

/** Heading copy with its *key word* drawn with the amber underline (see lib/marked.ts). */
export function Marked({ text }: { text: string }) {
  return (
    <>
      {splitMarks(text).map((p, i) => (p.marked ? <span key={i} className="mark">{p.text}</span> : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  );
}
