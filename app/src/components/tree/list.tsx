"use client";
/**
 * The Trust Tree on a phone (and narrow panes): the family by generation, one row per person, with the same facts and
 * the same cards as the map. Rows slide into place as people join (Motion layout), or appear at once with reduced
 * motion. Each row shows the person's photo, or their initials. Vertical only: nothing scrolls sideways at 360 px.
 */
import { AnimatePresence, m as motion } from "motion/react";
import { ChevronRight } from "@/components/ui/icons";
import type { PersonId, TreeAtYear } from "@/lib/tree/types";
import { RoleSwatch } from "./card";
import { Avatar } from "./photo";
import { factsFor, factsLine, fill, isMinorAt, lifeText, shortLabel, type Copy } from "./words";

export function TreeList({ at, copy, reduced, viewer, onOpen }: {
  at: TreeAtYear; copy: Copy; reduced: boolean; viewer: string | null; onOpen: (id: PersonId) => void;
}) {
  const gens = [...new Set(at.people.map((p) => p.generation))].sort((a, b) => a - b);
  if (at.people.length === 0) return <p className="py-10 text-center text-ink-2">{fill(copy.map.empty, { year: at.year })}</p>;
  return (
    <div className="grid gap-5" aria-label={fill(copy.list.label, { year: at.year })} role="group">
      {gens.map((g, i) => {
        const people = at.people.filter((p) => p.generation === g).sort((a, b) => (a.born ?? 9999) - (b.born ?? 9999));
        return (
          <section key={g} aria-labelledby={`gen-${g}`}>
            <h2 id={`gen-${g}`} className="eyebrow">{fill(copy.map.generation, { n: i + 1 })}</h2>
            <ul className="mt-2 grid gap-2">
              <AnimatePresence initial={false}>
                {people.map((p) => {
                  const name = shortLabel(copy, p, at.year);
                  const restricted = p.hidden || isMinorAt(p, at.year);
                  const f = factsFor(at, p.id);
                  const life = restricted ? "" : lifeText(copy, p);
                  const me = !!viewer && p.wallets.includes(viewer);
                  const roles = [...new Set(f.roles.filter((e) => e.toTs === undefined).map((e) => e.role))];
                  return (
                    <motion.li
                      key={p.id}
                      layout={!reduced}
                      initial={reduced ? false : { opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduced ? undefined : { opacity: 0 }}
                      transition={{ duration: reduced ? 0 : 0.35 }}
                    >
                      <button
                        type="button"
                        onClick={() => onOpen(p.id)}
                        data-person={p.id}
                        className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-line bg-surface p-3 text-left hover:border-line-strong"
                      >
                        <Avatar p={p} name={name} me={me} className="size-11 text-small" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold">{name}{me ? ` · ${copy.person.you}` : ""}</span>
                          {(life || !p.alive) && (
                            <span className="block text-small text-ink-2 tabular-nums">
                              {life}{!p.alive ? `${life ? " · " : ""}${copy.map.passedMark}` : ""}
                            </span>
                          )}
                          {!restricted && <span className="block text-small text-ink-2">{factsLine(copy, f)}</span>}
                          {!restricted && roles.length > 0 && (
                            <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                              {roles.map((r) => (
                                <span key={r} className="inline-flex items-center gap-1.5 text-[0.75rem] font-medium text-ink"><RoleSwatch role={r} />{copy.roles[r]}</span>
                              ))}
                            </span>
                          )}
                        </span>
                        <ChevronRight className="size-5 shrink-0 text-ink-2" aria-hidden="true" />
                      </button>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          </section>
        );
      })}
    </div>
  );
}
