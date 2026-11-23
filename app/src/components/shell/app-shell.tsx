"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { FileCheck2, HandCoins, House, Inbox, Menu, MessageCircle, PanelLeftClose, PanelLeftOpen } from "@/components/ui/icons";
import type { CommonCopy } from "@/content/common";
import type { AssistantCopy } from "@/content/assistant";
import type { PayCopy } from "@/content/pay";
import type { GuardiansCopy } from "@/content/guardians";
import type { DisputesCopy } from "@/content/disputes";
import { ConnectionBars, PaymentProvider } from "@/components/pay/payment";
import { EstateProvider, useEstate } from "@/lib/hooks/estate";
import { useBackClose } from "@/lib/hooks/use-back-close";
import { useWallet } from "@/lib/hooks/wallet-source";
import { chainConfig } from "@/lib/chain/config";
import { LogoMark } from "@/components/ui/primitives";
import { Toaster } from "@/components/ui/client";
import { AgentActionBridge } from "@/components/agent/chat-parts";
import { ChatProvider, useAttention } from "@/components/chat/chat-context";
import { Avatar } from "./avatar";
import { CopyProvider, fmt, useCopy } from "./copy";
import { PinGate } from "./pin-gate";
import { DemoGuide } from "./demo-guide";
import { EstateSwitcher } from "./estate-switcher";
import { Sidebar } from "./sidebar";
import { applyTheme, useTheme } from "./theme";
import { LanguageSwitcher } from "@/components/site/language-switcher";
import { useLocalized } from "@/lib/i18n/client";
import { useNow } from "@/lib/hooks/use-now";
import { guardiansOf, guardianTodo } from "@/components/guardians/derive";
import { AliveBanner } from "@/components/guardians/recipient";
import { canSign, claimVote, deathVote, hardshipVote, hasInbox, ownerMayApprove } from "@/lib/guardians/decisions";
import { disputesToDecide } from "@/components/disputes/disputes";
import { StarterBanner } from "@/components/continuity/continuity";

export { Avatar } from "./avatar";

// Sheets that start closed: fetched once the first screen has settled (or as soon as one is opened), so the page
// never waits on their code (the agent sheet brings the chat and voice layers). Nothing of theirs shows until opened.
const PersonaSheet = dynamic(() => import("./persona-sheet").then((m) => m.PersonaSheet), { ssr: false });
const ProofDrawer = dynamic(() => import("./proof-drawer").then((m) => m.ProofDrawer), { ssr: false });
const AgentSheet = dynamic(() => import("@/components/agent/agent-sheet").then((m) => m.AgentSheet), { ssr: false });

const COLLAPSE_KEY = "heirloom.sidebar";

/** True once the page has shown its data (or has none to wait for) and the browser has had an idle moment. */
function useSettled(waiting: boolean): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (settled || waiting) return;
    const done = () => setSettled(true);
    if (typeof window.requestIdleCallback !== "function") { // Safari before 18
      const t = window.setTimeout(done, 300);
      return () => window.clearTimeout(t);
    }
    const id = window.requestIdleCallback(done, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }, [settled, waiting]);
  return settled;
}

export function AppShell({ common: commonEn, assistant: assistantEn, pay: payEn, guardians: guardiansEn, disputes: disputesEn, siteName, children }: { common: CommonCopy; assistant: AssistantCopy; pay: PayCopy; guardians: GuardiansCopy; disputes: DisputesCopy; siteName: string; children: ReactNode }) {
  // English is passed from the server; the visitor's language (if any) is laid over it in the browser.
  const common = useLocalized(commonEn, (t) => t.common);
  const assistant = useLocalized(assistantEn, (t) => t.assistant);
  const pay = useLocalized(payEn, (t) => t.pay);
  const guardians = useLocalized(guardiansEn, (t) => t.guardians);
  const disputes = useLocalized(disputesEn, (t) => t.disputes);
  // Contract errors from the guardians and disputes features are explained in plain words like the rest.
  const errors = useMemo(() => ({ ...guardians.errors, ...disputes.errors, ...common.errors, ...guardians.rules.errors }), [guardians.errors, guardians.rules.errors, disputes.errors, common.errors]);
  return (
    <CopyProvider value={{ common, assistant, pay, guardians, disputes, siteName }}>
        <PinGate>
          <EstateProvider errors={errors}>
            <PaymentProvider><ChatProvider><Chrome>{children}</Chrome></ChatProvider></PaymentProvider>
          </EstateProvider>
        </PinGate>
    </CopyProvider>
  );
}

const roundBtn = "relative grid size-11 shrink-0 place-items-center rounded-full border border-line-strong bg-surface text-ink transition-colors hover:bg-surface-2";

function CountDot({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span aria-hidden="true" className="absolute -right-1 -top-1 grid min-w-5 place-items-center rounded-full bg-ink px-1 text-[0.7rem] font-bold leading-5 text-bg ring-2 ring-bg">{n}</span>;
}

/**
 * The frame every in-app page shares. Signed in: a sidebar (panel or icon rail on desktop, drawer on phones and tablets),
 * a slim top bar, and the page. The chat home (/chat) fills the main area; other pages sit in a centred column.
 * Onboarding and signed-out visitors get the top bar only.
 */
function Chrome({ children }: { children: ReactNode }) {
  const { common, assistant, siteName } = useCopy();
  const s = assistant.shell;
  const { session, role, snap, isMock: mockService, service, setProofOpen, phase, proofOpen, agent } = useEstate();
  // The service is created after mount; until then the build's data mode says whether this is the demo, so the
  // demo guide's space is reserved from the first paint.
  const isMock = service ? mockService : chainConfig.dataMode === "mock";
  const { nudges } = useAttention();
  const pathname = usePathname();
  const { theme } = useTheme();
  const [personaOpen, setPersonaOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const wallet = useWallet();
  const onboarding = pathname.startsWith("/start");
  // Until the wallet has loaded (it lives in this browser), assume the signed-in frame: in demo mode there is
  // always a persona, so the sidebar and demo guide are laid out from the first paint and nothing jumps.
  const framed = !onboarding && (!!session || !wallet.ready);
  const settled = useSettled(!wallet.ready || (!!session && phase === "loading"));
  const isChat = pathname === "/chat";
  const guardNow = useNow(15000);
  // Trusted people: their approvals plus objections to decide and passings to confirm; watchers: approvals they can still
  // object to. Anyone with something to decide here has the inbox, whatever role the wallet is signed in as (M10).
  const todo = snap ? pendingFor(snap, session?.address ?? "") + guardianTodo(guardiansOf(snap), snap, session?.address, guardNow) + disputesToDecide(snap, session?.address, guardNow) : 0;
  const inboxHere = hasInbox(snap, session?.address, role, todo);
  const inboxCount = inboxHere ? todo : 0;
  const ownerCount = role === "owner" && snap ? ownerPending(snap) : 0;

  // Apply the saved appearance choice (system is the default and needs no attribute).
  useEffect(() => { applyTheme(theme); }, [theme]);

  // The collapse choice is remembered on this device; read after mount so the server markup matches.
  useEffect(() => {
    // The width itself comes from <html data-sidebar>, set before first paint by the script in layout.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try { setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "collapsed"); } catch { /* ignore */ }
  }, []);
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (next) document.documentElement.dataset.sidebar = "collapsed";
    else delete document.documentElement.dataset.sidebar;
    try { window.localStorage.setItem(COLLAPSE_KEY, next ? "collapsed" : "open"); } catch { /* ignore */ }
  };

  // Phone drawer: a native modal dialog, so focus is trapped, Esc closes it and the page behind is inert.
  useEffect(() => {
    const d = drawer.current;
    if (!d) return;
    if (drawerOpen && !d.open) d.showModal();
    if (!drawerOpen && d.open) d.close();
  }, [drawerOpen]);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  useBackClose(drawerOpen, closeDrawer); // Android back closes the drawer first
  useEffect(() => {
    // The drawer is a phone pattern: close it if the window grows into the desktop layout.
    const mq = window.matchMedia("(min-width: 1280px)");
    const on = () => { if (mq.matches) setDrawerOpen(false); };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const badges = { inbox: inboxCount, claims: ownerCount };
  const openPersona = () => setPersonaOpen(true);
  const personaLabel = session ? fmt(common.persona.switchLabel, { name: session.label.replace(/\s*\(.*\)$/, ""), role: common.roles[session.role] }) : "";
  // --tabbar-h is the height of whatever is pinned to the bottom of the screen (the chat composer), so toasts clear it.
  const vars = { "--tabbar-h": framed && isChat ? "11.5rem" : "0rem" } as CSSProperties;

  return (
    <div className="min-h-dvh" style={vars}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[90] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2.5 focus:text-bg">{common.nav.skip}</a>

      {framed && (
        <>
          {/* Wide screens: the full panel, collapsible to an icon rail. */}
          <aside aria-label={s.sidebarLabel} className="fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar-w)] py-3 pl-3 xl:block">
            <div className="h-full overflow-hidden rounded-xl border border-line bg-surface">
              <Sidebar rail={collapsed} badges={badges} inbox={inboxHere} onPersona={openPersona} />
            </div>
          </aside>
          {/* Small laptops and tablets: always the rail, so pages keep their width; the menu button opens the full list. */}
          <aside aria-label={s.sidebarLabel} className="fixed inset-y-0 left-0 z-30 hidden w-[5.25rem] py-3 pl-3 lg:block xl:hidden">
            <div className="h-full overflow-hidden rounded-xl border border-line bg-surface">
              <Sidebar rail badges={badges} inbox={inboxHere} onPersona={openPersona} />
            </div>
          </aside>
        </>
      )}

      <div className={clsx("flex min-h-dvh min-w-0 flex-col", framed && "lg:pl-[5.25rem] xl:pl-[var(--sidebar-w)]")}>
        <header className={clsx("pt-safe sticky top-0 z-40 border-line bg-bg", framed ? "border-b lg:border-b-0" : "border-b")}>
          <div className={clsx("flex h-[var(--header-h)] w-full items-center gap-2", framed ? "px-3 lg:px-4" : "mx-auto max-w-6xl px-4")}>
            {framed ? (
              <>
                <button type="button" onClick={() => setDrawerOpen(true)} aria-label={s.openMenu} aria-haspopup="dialog" aria-expanded={drawerOpen} className={clsx(roundBtn, "xl:hidden")}>
                  <Menu className="size-5" aria-hidden="true" />
                </button>
                <Link href="/chat" aria-label={common.nav.home} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full lg:hidden">
                  <LogoMark className="size-9" />
                  <span className="hidden font-display text-[1.25rem] font-medium leading-none tracking-[-0.01em] min-[400px]:inline">{siteName}</span>
                </Link>
                <button type="button" onClick={toggleCollapsed} aria-label={collapsed ? s.expand : s.collapse} aria-expanded={!collapsed} title={collapsed ? s.expand : s.collapse} className={clsx(roundBtn, "hidden xl:grid")}>
                  {collapsed ? <PanelLeftOpen className="size-5" aria-hidden="true" /> : <PanelLeftClose className="size-5" aria-hidden="true" />}
                </button>
              </>
            ) : (
              <Link href={session ? "/chat" : "/"} aria-label={common.nav.home} className="flex shrink-0 items-center gap-2 rounded-full pr-1">
                <LogoMark className="size-9" />
                <span className="hidden font-display text-[1.25rem] font-medium leading-none tracking-[-0.01em] sm:inline">{siteName}</span>
              </Link>
            )}

            <div className="ml-auto flex min-w-0 items-center gap-2">
              {!framed && <LanguageSwitcher />}
              {!framed && isMock && (
                <button type="button" onClick={openPersona} title={common.demo.badgeHint} aria-haspopup="dialog" className="hidden min-h-11 shrink-0 items-center rounded-full px-1 min-[440px]:inline-flex">
                  {/* The accessible name starts with the visible words (WCAG 2.5.3), then says what the button does. */}
                  <span className="rounded-full border border-dashed border-ink px-2.5 py-1 text-[0.75rem] font-semibold text-ink">{common.demo.badge}</span>
                  <span className="sr-only">: {common.demo.open}</span>
                </button>
              )}
              {framed && (
                <>
                  <Link href="/chat" onClick={(e) => {
                    // Already on the chat home: the badge counts the cards there, so show them instead of doing nothing.
                    const stack = isChat && nudges.length ? document.getElementById("nudges") : null;
                    if (!stack) return;
                    e.preventDefault();
                    stack.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
                    stack.focus({ preventScroll: true });
                  }} aria-current={isChat ? "page" : undefined} aria-label={nudges.length ? fmt(s.top.homeCount, { n: nudges.length }) : s.top.home} title={s.top.home} className={clsx(roundBtn, isChat && "border-ink")}>
                    <House className="size-5" aria-hidden="true" /><CountDot n={nudges.length} />
                  </Link>
                  <button type="button" onClick={() => setProofOpen(true)} aria-label={common.proof.openLabel} title={common.proof.open} className={clsx(roundBtn, "hidden min-[400px]:grid")}>
                    <FileCheck2 className="size-5" aria-hidden="true" />
                  </button>
                  {inboxHere && (
                    <Link href="/inbox" aria-label={inboxCount ? fmt(s.top.inboxCount, { n: inboxCount }) : s.top.inbox} title={s.top.inbox} className={roundBtn}>
                      <Inbox className="size-5" aria-hidden="true" /><CountDot n={inboxCount} />
                    </Link>
                  )}
                  {role === "owner" && ownerCount > 0 && (
                    <Link href="/claims" aria-label={fmt(s.top.claimsCount, { n: ownerCount })} title={s.top.claims} className={roundBtn}>
                      <HandCoins className="size-5" aria-hidden="true" /><CountDot n={ownerCount} />
                    </Link>
                  )}
                </>
              )}
              {session && (
                <button type="button" onClick={openPersona} aria-label={personaLabel} title={personaLabel} className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-surface-2">
                  <Avatar name={session.label} role={session.role} />
                </button>
              )}
            </div>
          </div>
          <ConnectionBars />
          {framed && isMock && <div className="lg:px-4 lg:pb-1"><div className="overflow-hidden lg:rounded-xl"><DemoGuide /></div></div>}
        </header>

        <main
          id="main" tabIndex={-1}
          className={clsx("min-w-0 flex-1 outline-none", framed && isChat ? "flex flex-col" : clsx("mx-auto w-full max-w-6xl px-4 pt-5", framed ? "pb-28 lg:pb-16" : "pb-10"))}
        >
          {framed && <EstateSwitcher inset={isChat} />}
          <StarterBanner />
          {framed && <div className={clsx("empty:hidden", isChat && "px-4 pt-3")}><AliveBanner /></div>}
          {children}
        </main>
      </div>

      {framed && (
        <>
          {!isChat && pathname !== "/will" && (
            // In a landmark of its own, so screen-reader users can find it from the landmarks list.
            <nav aria-label={assistant.sheet.fabLabel} className="contents">
            <Link
              href="/chat"
              className="fixed bottom-[calc(var(--safe-b)+0.875rem)] right-[calc(var(--safe-r)+1rem)] z-30 inline-flex h-14 items-center gap-2 rounded-full bg-ink pl-4 pr-5 font-semibold text-bg shadow-raised ring-2 ring-bg transition-transform active:scale-95 lg:hidden"
            >
              <MessageCircle className="size-6" aria-hidden="true" />
              <span className="text-small">{assistant.sheet.fabLabel}</span>
            </Link>
            </nav>
          )}
          <dialog
            ref={drawer} className="drawer" aria-label={s.sidebarLabel}
            onClose={closeDrawer}
            onCancel={(e) => { e.preventDefault(); closeDrawer(); }}
            onClick={(e) => { if (e.target === drawer.current) closeDrawer(); }}
          >
            {drawerOpen && <Sidebar badges={badges} inbox={inboxHere} onPersona={openPersona} onNavigate={closeDrawer} onClose={closeDrawer} />}
          </dialog>
        </>
      )}

      {(settled || personaOpen) && <PersonaSheet open={personaOpen} onClose={() => setPersonaOpen(false)} />}
      {(settled || proofOpen) && <ProofDrawer />}
      {(settled || agent !== null) && <AgentSheet />}
      <AgentActionBridge />
      <Toaster dismissLabel={common.toast.dismiss} />
    </div>
  );
}

/** Living-plan claims the owner still has to approve. */
export function ownerPending(snap: NonNullable<ReturnType<typeof useEstate>["snap"]>): number {
  return snap.claims.filter((c) => ownerMayApprove(snap, c, Math.floor(Date.now() / 1000)) && !snap.asks?.[c.address]?.declinedAt).length;
}

/** Items a given trusted person still has to act on. */
export function pendingFor(snap: NonNullable<ReturnType<typeof useEstate>["snap"]>, address: string): number {
  const now = Math.floor(Date.now() / 1000);
  const death = canSign(deathVote(snap.estate, address)) ? 1 : 0;
  const claims = snap.claims.filter((c) => canSign(claimVote(snap, c, address, now))).length;
  const hardships = snap.hardships.filter((h) => canSign(hardshipVote(snap, h, address))).length;
  return death + claims + hardships;
}
