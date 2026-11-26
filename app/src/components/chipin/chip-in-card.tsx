"use client";
/**
 * "Chip in" on the owner's Vault screen (plan §21): the QR code and wallet link for a chosen amount, the public page
 * link to copy or share, and the recent chip-ins. Chain: found on the network by the estate's tag. Demo: no wallet
 * can pay the demo site, so "Simulate a chip-in" plays one, marked Simulated like every demo money movement.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, HandCoins, RefreshCw, Send } from "@/components/ui/icons";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { ExplorerLink } from "@/components/ui/explorer-link";
import { fmt, timeAgo, useCopy } from "@/components/shell/copy";
import { useLocalized } from "@/lib/i18n/client";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { isMockService } from "@/lib/service/is-mock";
import { formatUsdtExact, shortAddress } from "@/lib/format";
import { chipInPageUrl } from "@/lib/chipin/link";
import type { ChipIn } from "@/lib/chipin/types";
import { chipin as english } from "@/content/chipin";
import { useCanShare, useOrigin } from "@/lib/chipin/use-browser";
import { ChipInCode, type ChipInChoice } from "./chip-in-code";

const POLL_MS = 20_000;

export function ChipInCard({ estate, className }: { estate: string; className?: string }) {
  const c = useLocalized(english.card, (t) => t.chipin.card);
  const { common } = useCopy();
  const { service, isMock, refresh, notify, explain } = useEstate();
  const now = useNow(30_000);
  const origin = useOrigin();
  const canShare = useCanShare();
  const [choice, setChoice] = useState<ChipInChoice | null>(null);
  const [list, setList] = useState<ChipIn[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [simulating, setSimulating] = useState(false);

  const load = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    try { setList(await service.listChipIns(estate)); setFailed(false); } catch { setFailed(true); } finally { setLoading(false); }
  }, [service, estate]);

  useEffect(() => {
    if (!service) return;
    let live = true;
    const read = async () => {
      try { const found = await service.listChipIns(estate); if (live) { setList(found); setFailed(false); } } catch { if (live) setFailed(true); }
    };
    void read();
    // A wallet pays from another device: look again now and then while the page is open and visible.
    const id = isMock ? 0 : window.setInterval(() => { if (document.visibilityState === "visible") void read(); }, POLL_MS);
    return () => { live = false; window.clearInterval(id); };
  }, [service, estate, isMock]);

  const pageUrl = origin ? chipInPageUrl(origin, estate) : "";

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(pageUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };
  const share = async () => {
    try { await navigator.share({ title: c.shareTitle, text: c.shareText, url: pageUrl }); } catch { /* closed or refused */ }
  };
  const simulate = async () => {
    if (!isMockService(service) || !choice?.check.ok) return;
    setSimulating(true);
    try {
      const done = await service.simulateChipIn(choice.check.usdt);
      notify("ok", fmt(c.simulatedDone, { amount: formatUsdtExact(done.amount) }));
      await Promise.all([refresh(), load()]);
    } catch (e) { notify("error", explain(e).message); } finally { setSimulating(false); }
  };

  return (
    <Card className={className} role="region" aria-labelledby="chipin-title">
      <h2 id="chipin-title" className="flex items-center gap-2 text-h3"><HandCoins className="size-5 text-amber" aria-hidden="true" />{c.title}</h2>
      <p className="mt-1 text-ink-2">{c.body}</p>

      <div className="mt-4">
        <ChipInCode estate={estate} origin={origin} copy={c} idPrefix="chipin" onChange={setChoice} />
      </div>

      <p className="mt-3 text-small text-ink-2">{c.how} {isMock ? c.demo : c.devnet}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" small onClick={() => void copyLink()} disabled={!pageUrl}>
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}{copied ? c.copied : c.copyLink}
        </Button>
        {canShare && (
          <Button variant="secondary" small onClick={() => void share()} disabled={!pageUrl}>
            <Send className="size-4" aria-hidden="true" />{c.share}
          </Button>
        )}
        {isMock && (
          <Button small onClick={() => void simulate()} loading={simulating} disabled={!choice?.check.ok}>
            {fmt(c.simulate, { amount: choice?.check.ok ? formatUsdtExact(choice.check.base) : "" })}
          </Button>
        )}
      </div>
      <p className="sr-only" role="status">{copied ? c.copied : ""}</p>
      {pageUrl && <p className="mt-2 break-all font-mono text-small text-ink-2">{pageUrl}</p>}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body font-semibold">{c.recent}</h3>
        <Button variant="ghost" small onClick={() => void load()} loading={loading}>
          <RefreshCw className="size-4" aria-hidden="true" />{c.refresh}
        </Button>
      </div>
      {failed && <p className="mt-1 text-small text-ink-2" role="status">{c.loadError}</p>}
      {list && list.length === 0 && !failed && <p className="mt-1 text-small text-ink-2">{c.none}</p>}
      {list && list.length > 0 && (
        <ul className="mt-2 divide-y divide-line">
          {list.map((x) => (
            <li key={x.signature} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
              <div className="min-w-0">
                <p className="font-semibold tabular-nums">{formatUsdtExact(x.amount)}</p>
                <p className="text-small text-ink-2">
                  {fmt(c.from, { wallet: shortAddress(x.from, 4) })}
                  {now !== null && x.ts > 0 ? ` · ${timeAgo(x.ts, now, common.time)}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {x.simulated && <Badge tone="warn">{c.simulated}</Badge>}
                <ExplorerLink signature={x.signature} label={c.receipt} srLabel={c.receiptSr} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
