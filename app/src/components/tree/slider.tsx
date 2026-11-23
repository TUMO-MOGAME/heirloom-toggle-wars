"use client";
/**
 * The timeline: a native range input (arrow keys step a year, Home/End jump to the ends), the year in large type,
 * Play/Pause, a "today" marker and, in the demo, the imagined years marked by a dashed band and a label.
 */
import clsx from "clsx";
import { Pause, Play } from "@/components/ui/icons";
import { Badge, Button } from "@/components/ui/primitives";
import { fill, type Copy } from "./words";

export function TimelineSlider({
  copy, year, from, to, today, imagined, playing, onYear, onPlay,
}: {
  copy: Copy; year: number; from: number; to: number; today: number;
  /** Show the years after `today` as imagined (the demo story). */
  imagined: boolean;
  playing: boolean;
  onYear: (y: number) => void;
  onPlay: () => void;
}) {
  const span = Math.max(1, to - from);
  // The thumb is about 16 px wide, so its centre runs from 8 px to (100% - 8 px).
  const share = (y: number) => (y - from) / span;
  const at = (y: number) => `calc(8px + ${share(y) * 100}% - ${share(y) * 16}px)`;
  // Near either end, "Today · 2026" hugs that edge instead of hanging off it; decade labels make room for it by
  // their place on the track (a short chain history spans only a few years, so years apart can still collide).
  const todayEdge = share(today) > 0.88 ? "end" : share(today) < 0.12 ? "start" : null;
  const nearToday = (d: number) => Math.abs(share(d) - share(today)) < (todayEdge ? 0.24 : 0.14);
  const isImagined = imagined && year > today;
  const decades = [];
  for (let d = Math.ceil(from / 10) * 10; d <= to; d += 10) decades.push(d);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-3">
          <p className="font-display text-display leading-none tabular-nums" aria-hidden="true">{year}</p>
          {isImagined && <Badge tone="warn" className="mb-1.5">{copy.timeline.imagined}</Badge>}
          {!isImagined && year === today && <Badge tone="gold" className="mb-1.5">{copy.timeline.today}</Badge>}
        </div>
        <Button variant={playing ? "secondary" : "primary"} small onClick={onPlay} aria-pressed={playing}>
          {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
          {playing ? copy.timeline.pause : copy.timeline.play}
        </Button>
      </div>

      <div className="relative pb-7 pt-6">
        {imagined && today < to && (
          <div className="tree-imagined pointer-events-none absolute top-3" style={{ left: at(today), right: 8 }} aria-hidden="true">
            <span className="absolute -top-5 right-0 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-ink-2">{copy.timeline.imagined}</span>
          </div>
        )}
        <label htmlFor="tree-year" className="sr-only">{copy.timeline.label}</label>
        <input
          id="tree-year"
          type="range"
          min={from}
          max={to}
          step={1}
          value={year}
          onChange={(e) => onYear(Number(e.target.value))}
          aria-valuetext={isImagined ? fill(copy.timeline.imaginedYear, { year }) : String(year)}
          aria-describedby="tree-year-hint"
          className="tree-range relative block h-6 w-full cursor-pointer"
        />
        {/* Today marker under the track: the tick sits on the year; the label hugs an edge when today is near one. */}
        <span className="pointer-events-none absolute bottom-4 block h-2.5 w-0.5 -translate-x-1/2 bg-ink" style={{ left: at(today) }} aria-hidden="true" />
        <span
          className={clsx(
            "pointer-events-none absolute bottom-0 whitespace-nowrap text-[0.6875rem] font-semibold text-ink",
            todayEdge === "end" ? "right-0" : todayEdge === "start" ? "left-0" : "-translate-x-1/2",
          )}
          style={todayEdge ? undefined : { left: at(today) }}
          aria-hidden="true"
        >{copy.timeline.today} · {today}</span>
      </div>
      <div className="relative -mt-3 h-4 text-[0.6875rem] text-ink-2 tabular-nums" aria-hidden="true">
        {decades.map((d, i) => {
          const edge = i === 0 ? "start" : i === decades.length - 1 ? "end" : null;
          return (
            <span
              key={d}
              className={clsx("absolute", !edge && "-translate-x-1/2 max-sm:hidden", (Math.abs(d - today) < 5 || nearToday(d)) && "invisible")}
              style={edge === "start" ? { left: 0 } : edge === "end" ? { right: 0 } : { left: at(d) }}
            >{d}</span>
          );
        })}
      </div>
      <p id="tree-year-hint" className="text-small text-ink-2">{copy.timeline.hint}</p>
    </div>
  );
}
