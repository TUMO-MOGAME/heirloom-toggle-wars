"use client";
/**
 * The Trust Tree map (screens 720 px and wider): an SVG with generations as rows, quiet family lines, trust lines
 * as curves per role, and people as soft circles (their photo clipped inside, or initials). Motion: trust lines
 * draw themselves (a `pathLength` mask, so dashed roles draw too), people glide to their new place as the family grows, and an asset travels along the line
 * to its heir in the year it passes. With `reduced` nothing draws or travels: every change is instant.
 * Idea adapted from motion.dev's SVG path-drawing and layout examples, rebuilt on our tokens.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { animate, m as motion, useMotionValue, useTransform } from "motion/react";
import type { PersonId, TreeAtYear } from "@/lib/tree/types";
import {
  NODE_R, familyLines, initials, layoutTree, pointOnCubic, strokeFor, trustCurves, type TreeLayout,
} from "@/lib/tree/layout";
import { yearOf } from "@/lib/tree/timeline";
import { factsFor, factsLine, fill, holderBefore, isMinorAt, lifeText, shortLabel, type Copy } from "./words";

const ease = [0.22, 1, 0.36, 1] as const;

export interface Traveller { key: string; from: PersonId; to: PersonId; label: string }

/** Assets that pass to an heir in exactly this year (they travel along the line). */
export function travellersAt(at: TreeAtYear, copy: Copy): Traveller[] {
  const out: Traveller[] = [];
  for (const a of at.assets) {
    a.steps.forEach((s, i) => {
      if (s.kind !== "passedTo" || !s.to || yearOf(s.ts) !== at.year) return;
      out.push({ key: `${a.id}-${s.ts}`, from: holderBefore(a, i), to: s.to, label: a.title || copy.assetKinds[a.kind] });
    });
  }
  return out;
}

export function TreeMap({
  at, copy, width, reduced, viewer, onOpen,
}: {
  at: TreeAtYear; copy: Copy; width: number; reduced: boolean; viewer: string | null;
  onOpen: (id: PersonId) => void;
}) {
  const layout = useMemo(() => layoutTree(at.people, at.relationships, { width }), [at.people, at.relationships, width]);
  const lines = useMemo(() => familyLines(at.relationships, layout), [at.relationships, layout]);
  const curves = useMemo(() => trustCurves(at.edges, layout), [at.edges, layout]);
  const travellers = useMemo(() => travellersAt(at, copy), [at, copy]);
  const [focus, setFocus] = useState<PersonId | null>(null);
  const touches = (id: string, a: string, b: string) => focus === null || a === focus || b === focus || id === focus;
  const dur = (s: number) => (reduced ? { duration: 0 } : { duration: s, ease });
  const label = fill(copy.map.label, { year: at.year });

  if (at.people.length === 0) return <p className="py-16 text-center text-ink-2">{fill(copy.map.empty, { year: at.year })}</p>;

  return (
    <svg
      width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="group" aria-label={label} className="block max-w-full overflow-visible"
    >
      <defs>
        {!reduced && curves.map((c) => (
          <mask key={c.id} id={`tm-${c.id}`} maskUnits="userSpaceOnUse" x={-40} y={-200} width={layout.width + 80} height={layout.height + 400}>
            <motion.path
              d={c.d} fill="none" stroke="white" strokeLinecap="round" strokeWidth={strokeFor(c.edge.keptCount) + 8}
              initial={{ pathLength: 0, d: c.d }} animate={{ pathLength: 1, d: c.d }} transition={{ pathLength: { duration: 1.1, ease }, d: { duration: 0.6, ease } }}
            />
          </mask>
        ))}
      </defs>

      {/* Family lines: quiet, drawn first. */}
      <g aria-hidden="true" fill="none" stroke="var(--line-strong)" strokeWidth={1.25} strokeLinecap="round">
        {lines.map((l) => (
          <motion.path key={l.id} d={l.d} initial={reduced ? false : { opacity: 0, d: l.d }} animate={{ opacity: focus ? 0.35 : 0.8, d: l.d }} transition={dur(0.6)} />
        ))}
      </g>

      {/* Trust lines. */}
      <g aria-hidden="true">
        {curves.map((c) => {
          const ended = c.edge.toTs !== undefined;
          const on = touches(c.id, c.edge.from, c.edge.to);
          return (
            <motion.path
              key={c.id}
              className={`tree-trust tree-role-${c.edge.role}`}
              mask={reduced ? undefined : `url(#tm-${c.id})`}
              strokeWidth={ended ? Math.max(1.25, strokeFor(c.edge.keptCount) * 0.6) : strokeFor(c.edge.keptCount)}
              initial={reduced ? false : { d: c.d, opacity: 0 }}
              animate={{ d: c.d, opacity: on ? (ended ? 0.4 : 1) : 0.12 }}
              transition={dur(0.6)}
            />
          );
        })}
      </g>

      <Rows layout={layout} copy={copy} />

      {/* An asset travelling to its heir this year. */}
      {!reduced && travellers.map((t) => {
        const curve = curves.find((c) => c.edge.from === t.from && c.edge.to === t.to);
        const a = layout.nodes.get(t.from), b = layout.nodes.get(t.to);
        if (!a || !b) return null;
        const pts: [number, number][] = curve?.pts ?? [[a.x, a.y], [a.x, (a.y + b.y) / 2], [b.x, (a.y + b.y) / 2], [b.x, b.y]];
        return <Travel key={t.key} pts={pts} />;
      })}

      {/* People. */}
      {at.people.map((p) => {
        const pos = layout.nodes.get(p.id);
        if (!pos) return null;
        const name = shortLabel(copy, p, at.year);
        const facts = factsFor(at, p.id);
        const restricted = p.hidden || isMinorAt(p, at.year);
        const life = restricted ? "" : lifeText(copy, p);
        const me = !!viewer && p.wallets.includes(viewer);
        // Starts with the visible name (and years), so speech input can say what it sees.
        const aria = [
          [name, life].filter(Boolean).join(" "),
          !p.alive ? copy.map.passedMark : "",
          restricted ? "" : factsLine(copy, facts, ", "),
          fill(copy.map.open, { name }),
        ].filter(Boolean).join(". ");
        const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(p.id); } };
        return (
          <motion.g
            key={p.id}
            onPointerEnter={() => setFocus(p.id)}
            onPointerLeave={() => setFocus(null)}
            initial={reduced ? false : { x: pos.x, y: pos.y + 14, opacity: 0, scale: 0.6 }}
            animate={{ x: pos.x, y: pos.y, opacity: focus && focus !== p.id && !curves.some((c) => (c.edge.from === focus && c.edge.to === p.id) || (c.edge.to === focus && c.edge.from === p.id)) ? 0.55 : 1, scale: 1 }}
            transition={reduced ? { duration: 0 } : { duration: 0.6, ease, opacity: { duration: 0.3 } }}
          >
            {/* The button holds only shapes; its name says everything the text beside it shows. */}
            <g
              className="tree-node"
              role="button"
              tabIndex={0}
              aria-label={aria}
              data-person={p.id}
              onClick={() => onOpen(p.id)}
              onKeyDown={key}
              onFocus={() => setFocus(p.id)}
              onBlur={() => setFocus(null)}
            >
              {p.org
                ? <rect x={-NODE_R - 5} y={-NODE_R - 5} width={2 * NODE_R + 10} height={2 * NODE_R + 10} rx={14} className="tree-focus" />
                : <circle r={NODE_R + 5} className="tree-focus" />}
              <Person alive={p.alive} hidden={p.hidden} me={me} org={!!p.org} photo={p.hidden ? undefined : p.photo?.src} clipId={`tp-${p.id.replace(/[^A-Za-z0-9_-]/g, "_")}`} />
            </g>
            <g aria-hidden="true" className="cursor-pointer" onClick={() => onOpen(p.id)}>
              {!p.hidden && !p.photo && <text dy="0.35em" textAnchor="middle" className={`pointer-events-none ${p.alive ? "fill-ink" : "fill-ink-2"} text-[0.9375rem] font-semibold`}>{initials(name)}</text>}
              <text y={NODE_R + 18} textAnchor="middle" className="tree-halo fill-ink text-[0.8125rem] font-semibold">{name}</text>
              {life && <text y={NODE_R + 33} textAnchor="middle" className="tree-halo fill-ink-2 text-[0.75rem] tabular-nums">{life}</text>}
            </g>
          </motion.g>
        );
      })}
    </svg>
  );
}

function Rows({ layout, copy }: { layout: TreeLayout; copy: Copy }) {
  return (
    <g aria-hidden="true">
      {layout.rows.map((r, i) => (
        <text key={r.generation} x={12} y={r.y + 4} className="tree-halo fill-ink-2 text-[0.6875rem] font-semibold uppercase tracking-[0.12em]">
          {fill(copy.map.generation, { n: i + 1 })}
        </text>
      ))}
      {[...layout.outsideStart].map(([g, x]) => {
        const row = layout.rows.find((r) => r.generation === g);
        if (!row) return null;
        return (
          <text key={`o-${g}`} x={x - NODE_R} y={row.y - NODE_R - 14} className="tree-halo fill-ink-2 text-[0.6875rem] font-semibold uppercase tracking-[0.12em]">
            {copy.map.outside}
          </text>
        );
      })}
    </g>
  );
}

/**
 * A soft circle with initials, or the person's photo clipped to it (an organisation: a rounded square); someone who
 * has passed becomes an outline with a small mark. The outline is drawn over the photo, so the edge stays crisp.
 */
function Person({ alive, hidden, me, org, photo, clipId }: { alive: boolean; hidden: boolean; me: boolean; org: boolean; photo?: string; clipId: string }) {
  const look = {
    fill: alive ? "var(--surface-2)" : "var(--bg)",
    stroke: me ? "var(--amber)" : alive ? "var(--line-strong)" : "var(--ink-2)",
    strokeWidth: me ? 2.5 : 1.5,
    strokeDasharray: hidden ? "4 4" : undefined,
  };
  const shape = (props: Record<string, unknown>) => (org
    ? <rect x={-NODE_R} y={-NODE_R} width={2 * NODE_R} height={2 * NODE_R} rx={10} {...props} />
    : <circle r={NODE_R} {...props} />);
  const pic = photo && !hidden;
  return (
    <>
      {shape(look)}
      {pic && (
        <>
          <clipPath id={clipId}>{shape({})}</clipPath>
          <image
            href={photo} x={-NODE_R} y={-NODE_R} width={2 * NODE_R} height={2 * NODE_R}
            preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`} aria-hidden="true"
          />
          {shape({ ...look, fill: "none" })}
        </>
      )}
      {hidden && (
        <g stroke="var(--ink-2)" strokeWidth={1.5} fill="none" aria-hidden="true">
          <circle cy={-6} r={6} />
          <path d="M -11 13 a 11 9 0 0 1 22 0" />
        </g>
      )}
      {!alive && <circle cx={NODE_R * 0.72} cy={-NODE_R * 0.72} r={4.5} fill="var(--ink-2)" stroke="var(--bg)" strokeWidth={2} />}
    </>
  );
}

/** One asset gliding along a trust line to its heir, then resting there with a soft pulse. */
function Travel({ pts }: { pts: [number, number][] }) {
  const t = useMotionValue(0);
  const x = useTransform(t, (v) => pointOnCubic(pts, v)[0]);
  const y = useTransform(t, (v) => pointOnCubic(pts, v)[1]);
  useEffect(() => {
    const c = animate(t, 1, { duration: 1.4, ease, delay: 0.25 });
    return () => c.stop();
  }, [t]);
  return (
    <g aria-hidden="true">
      <motion.circle cx={x} cy={y} r={8} fill="var(--amber)" stroke="var(--bg)" strokeWidth={2.5} />
    </g>
  );
}
