"use client";
import { useEffect, type ReactNode } from "react";
import { CloudOff, ScrollText, UserRound, UsersRound } from "@/components/ui/icons";
import type { EstateSnapshot } from "@/lib/service";
import type { Role, WalletSession } from "@/lib/types";
import { useWallet } from "@/lib/hooks/wallet-source";
import { useEstate } from "@/lib/hooks/estate";
import { chainConfig } from "@/lib/chain/config";
import { Button, ButtonLink, EmptyState, LoadingCards, PageHeader, Skeleton } from "@/components/ui/primitives";
import { fmt, useCopy } from "./copy";
import { fullName, shortName } from "@/lib/names";
import { endFreshVisit, firstDemoPersona } from "@/lib/service/fresh-visit";
import { canStartOwnPlan } from "@/lib/wallet/roles";

interface GateProps {
  /** Roles allowed on this screen. Omit for everyone. */
  roles?: Role[];
  /** Also lets in a wallet of another role once its estate shows it belongs here (the inbox: M10). */
  allow?: (snap: EstateSnapshot | null, session: WalletSession) => boolean;
  /** Render even when no estate exists yet (the will writer does). */
  allowEmpty?: boolean;
  children: (ctx: { snap: EstateSnapshot | null; session: WalletSession; role: Role }) => ReactNode;
  /**
   * The page's static frame (heading, empty boxes, the chat composer...), shown while the wallet and estate load,
   * so the server-rendered first screen is the page itself rather than a placeholder. Content that depends on the
   * wallet or the estate stays out of it. Omit for the plain loading cards.
   */
  frame?: ReactNode;
  /**
   * What a first demo visit (Thabo, nothing saved) sees on a page where that is not the "no estate" screen (the plan
   * builder). Server-rendered and shown by CSS before any JavaScript runs; see lib/service/fresh-visit.ts.
   */
  fresh?: ReactNode;
}

/** Handles the states every screen shares: wallet loading, no wallet, wrong person, loading, error, no estate. */
export function Gate({ roles, allow, allowEmpty = false, children, frame, fresh }: GateProps) {
  const { common } = useCopy();
  const g = common.gate;
  const wallet = useWallet();
  const { phase, snap, session, refresh, loadError, isMock: mockService, service, resetDemo } = useEstate();
  // On a first demo visit the "no estate" screen shows before the demo service has loaded (see EstateProvider).
  const isMock = service ? mockService : chainConfig.dataMode === "mock";

  // The frame keeps the same place in the tree as the page, so a page that renders the same component in both
  // (the chat home) is not re-mounted when the wallet arrives.
  const loading = (label: string) => frame
    ? <>{frame}<span role="status" aria-live="polite" className="sr-only">{label}</span></>
    : <LoadingCards label={label} />;

  // A first demo visit is Thabo with no estate yet, so its screen is known before the wallet and the estate load:
  // render it beside the frame and let CSS pick (<html data-fresh>). Pages the owner can't open have none.
  const ownerPage = !roles || roles.includes("owner");
  const firstScreen = chainConfig.dataMode !== "mock" ? null
    : fresh ?? (!allowEmpty && ownerPage ? <NoEstate session={firstDemoPersona()} isMock onDemo={() => void resetDemo("funded")} /> : null);
  const pending = (label: string) => firstScreen
    ? <><div className="fresh-only">{firstScreen}</div><div className="fresh-hide">{loading(label)}</div></>
    : loading(label);
  // The page itself goes in the first-visit block's place, so when it is the same screen (Thabo, no estate yet) React
  // keeps what is already on screen instead of drawing it again.
  const inPlace = (page: ReactNode) => firstScreen ? <div className="contents">{page}</div> : page;

  // Once the page shows its own state, a later reload of the estate (a demo stage, another persona) shows the
  // usual loading frame, not the first-visit screen.
  const settled = wallet.ready && phase !== "loading";
  useEffect(() => { if (settled) endFreshVisit(); }, [settled]);

  if (!wallet.ready) return pending(g.walletLoading);
  if (!session) {
    return <EmptyState level={1} icon={<UserRound className="size-6" aria-hidden="true" />} title={g.noWalletTitle} body={g.noWalletBody} action={<ButtonLink href="/start">{g.noWalletCta}</ButtonLink>} />;
  }
  // Another role that this estate shows belongs here: let it in once the estate has loaded.
  if (roles && !roles.includes(session.role) && allow && phase === "loading") return pending(g.loading);
  if (roles && !roles.includes(session.role) && !(allow && phase === "ready" && allow(snap, session))) {
    const other = wallet.sessions.find((s) => roles.includes(s.role));
    return (
      <EmptyState level={1}
        icon={<UsersRound className="size-6" aria-hidden="true" />}
        title={fmt(g.wrongRoleTitle, { roles: roles.map((r) => common.persona.groups[r].toLowerCase()).join(", ") })}
        body={fmt(g.wrongRoleBody, { name: fullName(session.label), role: common.roles[session.role].toLowerCase() })}
        action={
          <>
            {canStartOwnPlan(roles, session.role, isMock)
              ? <Button onClick={() => wallet.setRole(session.address, "owner")}>{g.startOwnPlan}</Button>
              : other && <Button onClick={() => wallet.switchTo(other.address)}>{fmt(common.demo.switchTo, { name: shortName(other.label) })}</Button>}
            <ButtonLink href="/estate" variant="secondary">{g.backToEstate}</ButtonLink>
          </>
        }
      />
    );
  }
  if (phase === "loading") return pending(g.loading);
  if (phase === "error") {
    return (
      <EmptyState level={1}
        icon={<CloudOff className="size-6" aria-hidden="true" />} title={g.errorTitle} body={g.errorBody}
        action={<Button onClick={() => void refresh()}>{g.retry}</Button>}
      />
    );
  }
  if (!snap && !allowEmpty) return inPlace(<NoEstate session={session} isMock={isMock} onDemo={() => void resetDemo("funded")} />);
  void loadError;
  return inPlace(<>{children({ snap, session, role: session.role })}</>);
}

/** No estate yet: the owner starts the plan; in the demo anyone can jump to Thabo's funded estate. */
function NoEstate({ session, isMock, onDemo }: { session: WalletSession; isMock: boolean; onDemo: () => void }) {
  const g = useCopy().common.gate;
  const owner = session.role === "owner";
  return (
    <EmptyState level={1}
      icon={<ScrollText className="size-6" aria-hidden="true" />} title={g.noEstateTitle}
      body={`${owner ? g.noEstateOwner : fmt(g.noEstateOther, { name: shortName(session.label) })}${isMock ? ` ${g.noEstateDemoHint}` : ""}`}
      action={(owner || isMock) ? (
        <>
          {owner && <ButtonLink href="/will">{g.noEstateCta}</ButtonLink>}
          {/* Demo only: jump to the "funded" stage, where Thabo's Corolla and motorbike are on the estate. */}
          {isMock && <Button variant={owner ? "secondary" : "primary"} onClick={onDemo}>{g.noEstateDemo}</Button>}
        </>
      ) : undefined}
    />
  );
}

/** A page's frame for <Gate frame>: its own heading (static copy) above empty boxes, in the page's column width. */
export function HeaderFrame({ width, eyebrow, title, body }: { width: string; eyebrow?: string; title: string; body?: string }) {
  return (
    <div className={`mx-auto ${width}`}>
      <PageHeader eyebrow={eyebrow} title={title} body={body} />
      <div className="grid gap-4" aria-hidden="true">
        <Skeleton className="h-36 w-full rounded-lg!" />
        <Skeleton className="h-24 w-full rounded-lg!" />
      </div>
    </div>
  );
}
