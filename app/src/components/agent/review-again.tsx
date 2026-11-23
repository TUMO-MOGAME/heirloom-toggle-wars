"use client";
/**
 * A claim or hardship request whose review didn't finish (H7): it was sent, so it is not sent again. Its sender asks
 * for the review again with the same file (its fingerprint is checked against the one on-chain). A request sent
 * without a letter needs no file: the app writes the same request note again.
 */
import { useId, useState } from "react";
import { ScanSearch } from "@/components/ui/icons";
import type { Base58 } from "@/lib/types";
import { FilePicker } from "@/components/ui/client";
import { Button } from "@/components/ui/primitives";
import { useCopy } from "@/components/shell/copy";
import { ActionResult, useAction } from "@/components/guardians/parts";

export function ReviewAgain({ kind, subject, noFile = false, className }: { kind: "claim" | "hardship"; subject: Base58; noFile?: boolean; className?: string }) {
  const { common, guardians } = useCopy();
  const t = guardians.rules.review;
  const id = useId();
  const { act, busy, refusal } = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `review-${subject}`;
  const ask = async () => {
    if (!noFile && !file) { setError(t.needFile); return; }
    setError(null);
    await act(key, (s, est) => s.requestReview(est, { kind, subject, evidence: noFile ? null : file }), t.done);
  };
  return (
    <div role="group" aria-labelledby={`${id}-title`} className={`rounded-md border-[1.5px] border-dashed border-ink p-3 ${className ?? ""}`}>
      <p id={`${id}-title`} className="flex items-center gap-2 font-semibold"><ScanSearch className="size-4 shrink-0" aria-hidden="true" />{t.title}</p>
      <p className="mt-1 text-small">{noFile ? t.bodyNote : t.body}</p>
      {!noFile && <div className="mt-3"><FilePicker id={`${id}-file`} label={t.file} file={file} onFile={(f) => { setFile(f); setError(null); }} copy={common.file} /></div>}
      {error && <p role="alert" className="mt-2 border-l-4 border-ink pl-2 text-small font-semibold">{error}</p>}
      <Button className="mt-3" small loading={busy === key} disabled={!!busy} onClick={() => void ask()}>{t.cta}</Button>
      <ActionResult receipt={null} refusal={refusal} />
    </div>
  );
}
