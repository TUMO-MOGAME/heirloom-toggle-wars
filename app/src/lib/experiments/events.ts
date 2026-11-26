import { experiments } from "@/content/experiments";

/** The only events the app sends (plan §2). A name not in this list is a type error, and refused at run time too. */
export type ExperimentEvent = (typeof experiments.events)[number];
export type Variant = (typeof experiments.variants)[number];

const EVENTS: readonly string[] = experiments.events;
const VARIANTS: readonly string[] = experiments.variants;

export const isExperimentEvent = (name: unknown): name is ExperimentEvent => typeof name === "string" && EVENTS.includes(name);

/** Flagsmith's value for the flag, as a version the screen knows. Anything unknown (null, typos, numbers) is control. */
export function toVariant(value: unknown): Variant {
  return typeof value === "string" && VARIANTS.includes(value) ? (value as Variant) : "control";
}

/** Events counted once per visit (occurrence metrics). `plan_message` is counted every time (the guardrail's mean). */
export const ONCE_PER_VISIT: ReadonlySet<ExperimentEvent> = new Set<ExperimentEvent>(["plan_first_message", "plan_reviewed", "plan_signed"]);

/** An event's value is a finite number or nothing: never text, so no chat words or names can ride along. */
export const safeValue = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
