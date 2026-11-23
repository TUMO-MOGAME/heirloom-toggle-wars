"use client";
/**
 * One activity line with people's names in place of wallet addresses (lib/people.ts). Demo lines already carry
 * names and pass through as they are; devnet lines name each wallet the app knows and keep the short address for
 * the rest. The full address stays on hover (and the receipt link opens the transaction on Solana Explorer).
 */
import { useMemo } from "react";
import type { EstateSnapshot } from "@/lib/service/types";
import type { ActivityItem } from "@/lib/types";
import { activityParts, nameBook, type NameBook } from "@/lib/people";
import { useWallet } from "@/lib/hooks/wallet-source";
import { fmt, useCopy } from "./copy";

/** Inside the app: the names this estate and this device's saved wallets can give an activity line. */
export function useNameBook(snap: EstateSnapshot | null | undefined): NameBook {
  const { common } = useCopy();
  const { sessions } = useWallet();
  return useMemo(() => nameBook(snap, { wallets: sessions, agentLabel: common.roles.agent }), [snap, sessions, common.roles.agent]);
}

/** The public record (outside the wallet): the estate's own names only, so it reads the same for everyone. */
export function usePublicNameBook(snap: EstateSnapshot | null | undefined): NameBook {
  const { common } = useCopy();
  return useMemo(() => nameBook(snap, { agentLabel: common.roles.agent }), [snap, common.roles.agent]);
}

export function ActivityText({ item, book }: { item: Pick<ActivityItem, "text" | "parties"> & { kind?: string }; book: NameBook }) {
  const { common, guardians } = useCopy();
  // A new agent set back what the old one reviewed: said the same way in every language, on both sites.
  if (item.kind === "AgentReviewCleared") return <>{guardians.rules.agent.reviewsCleared}</>;
  const parts = activityParts(item, book);
  return (
    <>
      {parts.map((p, i) => ("address" in p
        ? <span key={i} title={p.named ? `${p.full ?? p.text} · ${fmt(common.proof.walletTitle, { address: p.address })}` : fmt(common.proof.walletTitle, { address: p.address })} className={p.named ? undefined : "font-mono"}>{p.text}</span>
        : <span key={i}>{p.text}</span>))}
    </>
  );
}
