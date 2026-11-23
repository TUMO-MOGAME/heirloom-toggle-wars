"use client";
import Link from "next/link";
import type { SiteCopy } from "@/content/site";
import { ButtonLink, Logo } from "@/components/ui/primitives";
import { Moon, Sun } from "@/components/ui/icons";
import { setTheme, useTheme } from "@/components/shell/theme";
import { useLocalized } from "@/lib/i18n/client";
import { LanguageSwitcher } from "./language-switcher";

/** Site chrome is shared by the landing, legal and 404 pages; English is rendered first, then the visitor's language. */

export function SiteHeader({ site: english, minimal = false }: { site: SiteCopy; minimal?: boolean }) {
  const site = useLocalized(english, (t) => t.site);
  return (
    <header className="pt-safe sticky top-0 z-40 border-b border-line bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2.5 focus:text-bg">{site.nav.skip}</a>
      <div className="mx-auto flex h-[var(--header-h)] w-full max-w-6xl items-center gap-1.5 px-3 min-[400px]:gap-3 min-[400px]:px-4">
        {/* Below 480px the wordmark gives way to the language switcher; the link keeps its accessible name. */}
        <Link href="/" aria-label={site.nav.home} className="shrink-0 rounded-full"><Logo name={site.name} className="max-[479px]:[&>span:last-child]:hidden" /></Link>
        {!minimal && (
          <nav aria-label={site.nav.menu} className="ml-6 hidden items-center gap-1 md:flex">
            {[["#how", site.nav.how], ["#safety", site.nav.safety], ["#proof", site.nav.proof]].map(([href, label]) => (
              <a key={href} href={`/${href}`} className="inline-flex min-h-11 items-center rounded-full px-3.5 text-small font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink">{label}</a>
            ))}
          </nav>
        )}
        <LanguageSwitcher className="ml-auto" />
        <ThemeSwitch label={site.nav.darkMode} />
        <ButtonLink href="/start" small className="shrink-0">{site.nav.open}</ButtonLink>
      </div>
    </header>
  );
}

/** Day / night, as on the sidebar: a switch that is on when the page is dark (the default). */
function ThemeSwitch({ label }: { label: string }) {
  const { dark } = useTheme();
  return (
    <button
      type="button" role="switch" aria-checked={dark} aria-label={label} title={label}
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="grid size-10 shrink-0 place-items-center min-[400px]:size-11 rounded-full border border-line text-ink hover:bg-surface-2"
    >
      {dark ? <Moon className="size-[18px]" /> : <Sun className="size-[18px]" />}
    </button>
  );
}

export function SiteFooter({ site: english, photoCredit = false }: { site: SiteCopy; photoCredit?: boolean }) {
  const site = useLocalized(english, (t) => t.site);
  const f = site.footer;
  const heading = "font-sans text-[0.75rem] font-semibold uppercase leading-none tracking-[0.14em] text-ink";
  const link = "inline-flex min-h-11 items-center text-small text-ink-2 underline-offset-4 hover:text-ink hover:underline";
  return (
    <footer className="border-t border-line bg-bg text-ink-2">
      <div className="mx-auto grid w-[min(1160px,100%_-_2*clamp(16px,4vw,40px))] gap-7 pb-6 pt-10 md:grid-cols-[1.2fr_1fr_1fr]">
        <div>
          <Link href="/" aria-label={site.nav.home} className="inline-flex rounded-full text-ink"><Logo name={site.name} /></Link>
          <p className="mt-3.5 max-w-[42ch] text-small">{f.blurb}</p>
          <p className="mt-3 text-small">{f.builtWith}</p>
          <p className="mt-2 text-small">{f.program}:{" "}<a href={`https://explorer.solana.com/address/${f.programId}?cluster=devnet`} target="_blank" rel="noreferrer noopener" className="break-all font-mono text-ink underline underline-offset-4">{f.programId}</a></p>
        </div>
        <nav aria-label={f.linksTitle}>
          <h2 className={heading}>{f.linksTitle}</h2>
          <ul className="mt-1.5">
            {f.links.map((l) => (
              <li key={l.href}><Link href={l.href} className={link}>{l.label}</Link></li>
            ))}
          </ul>
        </nav>
        <nav aria-label={f.legalTitle}>
          <h2 className={heading}>{f.legalTitle}</h2>
          <ul className="mt-1.5">
            {f.legal.map((l) => (
              <li key={l.href}><Link href={l.href} className={link}>{l.label}</Link></li>
            ))}
          </ul>
        </nav>
        <div className="border-t border-line pt-5 md:col-span-3">
          <h2 className={heading}>{f.ectaTitle}</h2>
          <dl className="mt-3 grid gap-x-8 gap-y-1.5 text-small sm:grid-cols-2 lg:grid-cols-3">
            {f.ecta.map((row) => (
              <div key={row.term} className="grid grid-cols-[9.5rem_1fr] gap-2 max-[380px]:grid-cols-1 max-[380px]:gap-0">
                <dt>{row.term}</dt>
                <dd className="break-words font-medium text-ink">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <div className="pb-safe border-t border-line">
        <div className="mx-auto flex w-[min(1160px,100%_-_2*clamp(16px,4vw,40px))] flex-wrap justify-between gap-x-6 gap-y-1 py-4 text-small">
          <p>© 2026 {f.rights}</p>
          <p>
            {photoCredit && <>{f.photoCredit} · </>}
            {f.iconCredit.label} (<a href={f.iconCredit.href} target="_blank" rel="noreferrer noopener" className="text-ink underline underline-offset-4">{f.iconCredit.linkText}</a>)
          </p>
        </div>
      </div>
    </footer>
  );
}
