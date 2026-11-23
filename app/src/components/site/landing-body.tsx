"use client";
import { Fragment, useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import {
  ArrowRight, Banknote, Check, FileLock2, HeartPulse, KeyRound, Lock, PenLine, ShieldCheck, Smartphone, UsersRound, Zap,
} from "@/components/ui/icons";
import { receiptTxs, type LandingCopy } from "@/content/landing";
import { Marked } from "@/components/ui/marked";
import { useLocalized } from "@/lib/i18n/client";

const stripIcons = [Banknote, Smartphone, Zap, UsersRound];
const safetyIcons = [Lock, UsersRound, HeartPulse, ShieldCheck, FileLock2, KeyRound];
const purposePhotos: { name: string; w: number; h: number; large?: number; position?: string }[] = [
  { name: "students", w: 800, h: 533 },
  { name: "graduation", w: 800, h: 1200 },
  { name: "walk", w: 800, h: 1200, position: "40% 60%" },
  { name: "car", w: 800, h: 600, large: 1280 },
];
/** Which of the three plan rules start now in the "sign" mock-up (books, tuition) and which wait (the car). */
const startsNow = [true, true, false];
const receiptDots = [
  { Icon: Check, tone: "lp-dot-ok" },
  { Icon: UsersRound, tone: "lp-dot-amber" },
  { Icon: ShieldCheck, tone: "" },
  { Icon: PenLine, tone: "" },
];

const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const shortSig = (sig: string) => `${sig.slice(0, 4)}â€¦${sig.slice(-4)}`;
const delay = (s: number) => ({ "--d": `${s}s` }) as CSSProperties;

/**
 * A pre-optimised landing photo (public/landing/<name>-800.webp and -1600.webp, WebP q72 from the Unsplash
 * originals). A plain img: next/image would re-encode files that are already sized and compressed.
 */
function Photo({ name, w, h, alt, sizes, large = 1600, widths, priority = false, style }: {
  name: string; w: number; h: number; alt: string; sizes: string; large?: number; widths?: number[]; priority?: boolean; style?: CSSProperties;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- fixed-width WebPs made with sharp (see above)
    <img
      src={`/landing/${name}-800.webp`}
      srcSet={(widths ?? [800, large]).map((x) => `/landing/${name}-${x}.webp ${x}w`).join(", ")}
      sizes={sizes} width={w} height={h} alt={alt} style={style} decoding="async"
      loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : undefined}
    />
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow" data-reveal>{children}</p>;
}

/**
 * Below-the-fold reveals, as progressive enhancement: the page is complete without JavaScript. After hydration,
 * only elements still below the screen are marked `data-pending` (hidden by landing.css) and shown as they
 * scroll in. Skipped entirely with reduced motion. Set up when the browser is idle and without layout reads
 * (the observer reports positions), so it adds nothing to hydration and never forces the skipped
 * `content-visibility` sections to render.
 */
function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || !("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const seen = new WeakSet<Element>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const node = e.target as HTMLElement;
        if (!seen.has(node)) {
          seen.add(node);
          // First report: on screen or above it stays as it is; below the screen waits for its reveal.
          if (!e.isIntersecting && e.rootBounds && e.boundingClientRect.top > e.rootBounds.bottom) node.dataset.pending = "";
          else io.unobserve(node);
        } else if (e.isIntersecting) {
          delete node.dataset.pending;
          io.unobserve(node);
        }
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    const start = () => { for (const node of el.querySelectorAll("[data-reveal]")) io.observe(node); };
    // Safari has no requestIdleCallback.
    const ric = window.requestIdleCallback as typeof window.requestIdleCallback | undefined;
    const idle = ric ? ric(start, { timeout: 2000 }) : setTimeout(start, 200);
    return () => {
      if (ric) window.cancelIdleCallback(idle as number); else clearTimeout(idle);
      io.disconnect();
      for (const node of el.querySelectorAll<HTMLElement>("[data-pending]")) delete node.dataset.pending;
    };
  }, [root]);
}

/**
 * The landing page's sections. Prerendered in English (the first screen needs no JavaScript: its entrance is
 * CSS-only); after hydration the visitor's chosen language is laid over the same markup.
 */
export function LandingBody({ copy: english }: Readonly<{ copy: LandingCopy }>) {
  const { hero, strip, problem, purposes, how, safety, proof, cta } = useLocalized(english, (t) => t.landing);
  const main = useRef<HTMLElement>(null);
  useReveal(main);

  return (
    <main id="main" ref={main} className="lp">
      {/* Hero */}
      <section className="lp-hero" aria-labelledby="hero-title">
        <div className="lp-wrap">
          <div className="lp-copy">
            <p className="eyebrow">{hero.eyebrow}</p>
            <h1 id="hero-title" className="font-display"><Marked text={hero.title} /></h1>
            <p className="lp-lede">{hero.body}</p>
            <div className="lp-actions">
              <Link href="/start" className="lp-btn lp-btn-primary">{hero.primary}<ArrowRight className="lp-ic" /></Link>
              <a href="#how" className="lp-btn lp-btn-ghost">{hero.secondary}</a>
            </div>
            <p className="lp-note"><Check className="lp-ic" />{hero.note}</p>
          </div>

          <div className="lp-stage">
            <div className="lp-arch">
              <Photo name="dad-son" w={800} h={592} alt={hero.photoAlt} sizes="(min-width: 900px) 760px, 140vw" widths={[800, 1200, 1600]} priority />
            </div>
            <div className="lp-card lp-receipt" aria-hidden="true">
              <span className="lp-tick"><Check className="lp-ic" /></span>
              <div><b className="lp-num">{hero.receipt.title}</b><span>{hero.receipt.detail}</span></div>
            </div>
            <div className="lp-card lp-estate" role="img" aria-label={hero.card.label}>
              <div className="lp-estate-head"><span>{hero.card.title}</span><span className="lp-pill">{hero.card.status}</span></div>
              <div className="lp-vault">
                <small>{hero.card.vaultLabel}</small>
                <b className="font-display lp-num">{hero.card.vault}</b><span>{hero.card.vaultZar}</span>
              </div>
              <ul className="lp-rows">
                {hero.card.rows.map((row) => (
                  <li key={row.label}>
                    <span>{row.label}</span>
                    <span className="lp-d">{row.detail}</span>
                    <span className="lp-a lp-num">{row.amount}<small>{row.state}</small></span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* The "built with" strip */}
      <div className="lp-strip">
        <ul className="lp-wrap" aria-label={strip.label}>
          {strip.items.map((item, i) => {
            const Icon = stripIcons[i];
            return <li key={item.term}><Icon className="lp-ic" /><b>{item.term}</b> {item.detail}</li>;
          })}
        </ul>
      </div>

      {/* The problem */}
      <section className="lp-section lp-problem" aria-labelledby="problem-title">
        <div className="lp-wrap">
          <figure className="lp-worry" data-reveal>
            <Photo name="worry" w={800} h={1067} alt={problem.photoAlt} sizes="(min-width: 1160px) 440px, (min-width: 900px) 38vw, 92vw" />
            <figcaption className="font-display">{problem.caption}</figcaption>
          </figure>
          <div>
            <Eyebrow>{problem.eyebrow}</Eyebrow>
            <h2 id="problem-title" className="font-display" data-reveal><Marked text={problem.title} /></h2>
            <p className="lp-lede" data-reveal>{problem.body}</p>
            <ul className="lp-facts">
              {problem.facts.map((f, i) => (
                <li key={f.value} data-reveal style={delay(i * 0.08)}>
                  <b className="font-display lp-num" aria-hidden="true">{f.value}</b>
                  <span aria-hidden="true"><strong>{f.lead}</strong>{f.rest ? ` ${f.rest}` : ""}</span>
                  <span className="sr-only">{f.say}</span>
                </li>
              ))}
            </ul>
            <p className="lp-source" data-reveal>
              {problem.sourcesLabel}{" "}
              {problem.sources.map((s, i) => (
                <Fragment key={s.href}>
                  {i > 0 && "; "}
                  <a href={s.href} target="_blank" rel="noreferrer noopener">{s.label}</a>
                </Fragment>
              ))}.
            </p>
          </div>
        </div>
      </section>

      {/* What it pays for */}
      <section id="purposes" className="lp-section" aria-labelledby="purposes-title">
        <div className="lp-wrap">
          <div className="lp-head">
            <div>
              <Eyebrow>{purposes.eyebrow}</Eyebrow>
              <h2 id="purposes-title" className="font-display" data-reveal><Marked text={purposes.title} /></h2>
            </div>
            <p className="lp-lede" data-reveal>{purposes.body}</p>
          </div>
          <ul className="lp-purposes">
            {purposes.items.map((item, i) => {
              const photo = purposePhotos[i];
              return (
                <li key={photo.name} className="lp-purpose" data-reveal style={delay(i * 0.06)}>
                  <div className="lp-ph">
                    <Photo
                      name={photo.name} w={photo.w} h={photo.h} alt={item.alt} large={photo.large}
                      sizes="(min-width: 1160px) 280px, (min-width: 1040px) 24vw, (min-width: 640px) 46vw, 92vw"
                      style={photo.position ? { objectPosition: photo.position } : undefined}
                    />
                  </div>
                  <div className="lp-body">
                    <span className="lp-tag">{item.tag}</span>
                    <h3 className="font-display">{item.title}</h3>
                    <p className="lp-amt font-display lp-num">{item.amount}</p>
                    <p className="lp-desc">{item.body}</p>
                    <p className="lp-to"><ArrowRight className="lp-ic" />{item.to}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="lp-section" aria-labelledby="how-title">
        <div className="lp-wrap">
          <div className="lp-head">
            <div>
              <Eyebrow>{how.eyebrow}</Eyebrow>
              <h2 id="how-title" className="font-display" data-reveal><Marked text={how.title} /></h2>
            </div>
            <p className="lp-lede" data-reveal>{how.body}</p>
          </div>
          <ol className="lp-steps">
            {how.steps.map((step, i) => (
              <li key={step.title} className="lp-step">
                <div data-reveal>
                  <span className="lp-n font-display" aria-hidden="true">{i + 1}</span>
                  <h3 className="font-display">{step.title}</h3>
                  <p>{step.body}</p>
                </div>
                {i === 0 && (
                  <div className="lp-visual" data-reveal style={delay(0.1)} role="img" aria-label={how.chat.label}>
                    <span className="lp-who lp-r">{how.chat.me}</span>
                    <div className="lp-bubble lp-me">{how.chat.ask}</div>
                    <span className="lp-who">{how.chat.agent}</span>
                    <div className="lp-bubble lp-ai">{how.chat.reply}<ul>{how.chat.plan.map((p) => <li key={p}>{p}</li>)}</ul></div>
                  </div>
                )}
                {i === 1 && (
                  <div className="lp-visual" data-reveal style={delay(0.1)} role="img" aria-label={how.sign.label}>
                    <div className="lp-bal">
                      <div><small>{how.sign.vaultLabel}</small><b className="font-display lp-num">{how.sign.vault}</b></div>
                      <small>{how.sign.vaultZar}</small>
                    </div>
                    {how.sign.rows.map((row, r) => (
                      <div key={row.title} className="lp-toggle">
                        <div>{row.title}<small>{row.detail}</small></div>
                        <span className="lp-seg">
                          <span className={startsNow[r] ? "lp-on" : undefined}>{how.sign.now}</span>
                          <span className={startsNow[r] ? undefined : "lp-on"}>{how.sign.after}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {i === 2 && (
                  <div className="lp-visual lp-photo" data-reveal style={delay(0.1)}>
                    <Photo name="sunset" w={800} h={1200} alt={how.timeline.alt} sizes="(min-width: 1160px) 560px, (min-width: 900px) 45vw, 92vw" />
                    <div className="lp-card lp-over">
                      <ul className="lp-timeline">
                        {how.timeline.items.map((t, n) => <li key={t} className={n === 1 ? "lp-wait" : undefined}>{t}</li>)}
                      </ul>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Trust and safety */}
      <section id="safety" className="lp-section" aria-labelledby="safety-title">
        <div className="lp-wrap">
          <div className="lp-head">
            <div>
              <Eyebrow>{safety.eyebrow}</Eyebrow>
              <h2 id="safety-title" className="font-display" data-reveal><Marked text={safety.title} /></h2>
            </div>
          </div>
          <div className="lp-safety-grid">
            <figure className="lp-hands" data-reveal>
              <Photo name="hands" w={800} h={600} alt={safety.photoAlt} sizes="(min-width: 1160px) 460px, (min-width: 1000px) 40vw, 92vw" />
              <blockquote className="font-display">{safety.quote}</blockquote>
            </figure>
            <ul className="lp-rules">
              {safety.items.map((item, i) => {
                const Icon = safetyIcons[i];
                return (
                  <li key={item.title} className="lp-rule" data-reveal style={delay(i * 0.05)}>
                    <span className="lp-rule-ic"><Icon className="lp-ic" /></span>
                    <h3 className="font-display">{item.title}</h3>
                    <p>{item.body}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>

      {/* Proof */}
      <section id="proof" className="lp-section lp-proof" aria-labelledby="proof-title">
        <div className="lp-wrap">
          <div>
            <Eyebrow>{proof.eyebrow}</Eyebrow>
            <h2 id="proof-title" className="font-display" data-reveal><Marked text={proof.title} /></h2>
            <p className="lp-lede" data-reveal>{proof.body}</p>
            <dl className="lp-points">
              {proof.points.map((p) => (
                <div key={p.term} data-reveal><dt>{p.term}</dt><dd>{p.detail}</dd></div>
              ))}
            </dl>
          </div>
          <div className="lp-card lp-ledger" role="group" aria-labelledby="receipts-title" data-reveal style={delay(0.1)}>
            <div className="lp-ledger-head"><p id="receipts-title">{proof.receipts.title}</p><span>{proof.receipts.network}</span></div>
            <ol>
              {proof.receipts.rows.map((row, i) => {
                const { Icon, tone } = receiptDots[i];
                const sig = receiptTxs[i];
                return (
                  <li key={sig}>
                    <span className={`lp-dot ${tone}`}><Icon className="lp-ic" /></span>
                    <span className="lp-t">{row.title}</span>
                    <span className="lp-h">
                      <a href={explorerTx(sig)} target="_blank" rel="noreferrer noopener">{shortSig(sig)}<span className="sr-only">, {proof.receipts.open}</span></a> Â· {row.detail}
                    </span>
                    <span className="lp-v lp-num">{row.amount}</span>
                  </li>
                );
              })}
            </ol>
          </div>
          <p className="lp-honest" data-reveal>{proof.honest}</p>
        </div>
      </section>

      {/* Closing call to action */}
      <section id="cta" className="lp-section lp-cta" aria-labelledby="cta-title">
        <div className="lp-cta-grid">
          <div className="lp-cta-text">
            <Eyebrow>{cta.eyebrow}</Eyebrow>
            <h2 id="cta-title" className="font-display" data-reveal><Marked text={cta.title} /></h2>
            <p data-reveal>{cta.body}</p>
            <div className="lp-actions" data-reveal>
              <Link href="/start" className="lp-btn lp-btn-primary">{cta.primary}<ArrowRight className="lp-ic" /></Link>
              <Link href="/start?new=1" className="lp-btn lp-btn-ghost">{cta.secondary}</Link>
            </div>
          </div>
          <div className="lp-cta-photo">
            <Photo name="walk" w={800} h={1200} alt={cta.photoAlt} sizes="(min-width: 900px) 35vw, 100vw" />
            <div className="lp-card"><b className="font-display">{cta.card.title}</b>{cta.card.body}</div>
          </div>
        </div>
      </section>
    </main>
  );
}
