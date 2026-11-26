"use client";
/**
 * The public chip-in page (/chip-in/<estate>): what a relative opens from a shared link. No wallet connects here and
 * nothing is signed in the browser: the code and the "Open in a wallet" link hand the request to their own wallet
 * (Solana Pay transaction request). Blink clients unfurl the same URL through /actions.json. No names are shown:
 * the page knows only the vault's address.
 */
import { Info, ShieldCheck } from "@/components/ui/icons";
import { Card, Notice, PageHeader } from "@/components/ui/primitives";
import { useLocalized } from "@/lib/i18n/client";
import { isAddress } from "@/lib/chipin/link";
import { useOrigin } from "@/lib/chipin/use-browser";
import { shortAddress } from "@/lib/format";
import { chipin as english } from "@/content/chipin";
import { ChipInCode } from "./chip-in-code";

const demo = process.env.NEXT_PUBLIC_DATA_MODE !== "chain";

export function ChipInPage({ estate }: { estate: string }) {
  const c = useLocalized(english, (t) => t.chipin);
  const origin = useOrigin();
  const p = c.page;

  if (!isAddress(estate)) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader eyebrow={p.eyebrow} title={p.title} />
        <Notice tone="warn" icon={<Info className="size-5" aria-hidden="true" />}>{p.badLink}</Notice>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader eyebrow={p.eyebrow} title={p.title} body={p.body} />
      {demo && <Notice tone="warn" icon={<Info className="size-5" aria-hidden="true" />} className="mb-4">{c.card.demo}</Notice>}
      <Card>
        <h2 className="text-h3">{p.stepsLabel}</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-2">
          {p.steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
        <div className="mt-4">
          <ChipInCode estate={estate} origin={origin} copy={c.card} idPrefix="chipin-page" />
        </div>
        <p className="mt-3 text-small text-ink-2">{c.card.how}{demo ? "" : ` ${c.card.devnet}`}</p>
        <p className="mt-3 text-small text-ink-2">{p.vault}: <span className="font-mono" title={estate}>{shortAddress(estate, 6)}</span></p>
      </Card>
      <p className="mt-4 flex items-start gap-2 text-small text-ink-2"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{p.safety}</p>
    </div>
  );
}
