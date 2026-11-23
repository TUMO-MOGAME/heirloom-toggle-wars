"use client";
/**
 * Before signing (plan §18.4 U2): three different real trusted people, a warning when one is also in the family, and
 * every scheduled payment's payee. A schedule is never turned into a rule paid on request unless the owner says so.
 */
import { TriangleAlert, UsersRound } from "@/components/ui/icons";
import type { WillDraft } from "@/lib/types";
import type { TrustedProblem } from "@/lib/continuity/practice";
import { formatUsdt, toBase } from "@/lib/format";
import { Button, Notice } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";

export function SetupChecks({ draft, every, trusted, missing, made, refused, onFixPeople, onFixWallets, onPractice, onRequest }: {
  draft: WillDraft;
  every: Record<NonNullable<WillDraft["rules"][number]["recurring"]>["every"], string>;
  trusted: { problem: TrustedProblem | null; heirs: string[] };
  missing: { index: number; name: string }[];
  /** Practice payees that signing will make. */
  made: string[];
  /** The service refused the signature because of a payee. */
  refused: boolean;
  onFixPeople: () => void;
  onFixWallets?: () => void;
  onPractice: () => void;
  onRequest: (index: number) => void;
}) {
  const g = useCopy().guardians;
  const t = g.rules.setup;
  const { problem, heirs } = trusted;
  const byWallet = problem === "sameWallet" || problem === "wallet" || problem === "owner";
  if (!problem && !heirs.length && !missing.length && !made.length && !refused) return null;
  return (
    <div className="mt-6 grid gap-3 *:min-w-0" aria-live="polite">
      {problem && (
        <Notice tone="danger" icon={<UsersRound className="size-5" aria-hidden="true" />} title={t.trustedTitle}>
          <p className="mt-1">{t.problems[problem]}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button small variant="secondary" onClick={onFixPeople}>{t.fixPeople}</Button>
            {byWallet && onFixWallets && <Button small variant="secondary" onClick={onFixWallets}>{t.fixWallets}</Button>}
          </div>
        </Notice>
      )}
      {!problem && heirs.length > 0 && <Notice tone="warn"><p>{fmt(t.heirs, { names: heirs.join(", ") })}</p></Notice>}
      {(missing.length > 0 || refused) && (
        <Notice tone="danger" icon={<TriangleAlert className="size-5" aria-hidden="true" />} title={t.missingTitle}>
          <p className="mt-1">{refused && !missing.length ? g.rules.errors.recurring_payee : t.missingBody}</p>
          <ul className="mt-2 grid gap-2 *:min-w-0">
            {missing.map(({ index, name }) => {
              const r = draft.rules[index];
              if (!r?.recurring) return null;
              return (
                <li key={index} className="border-t border-line pt-2">
                  <p className="break-words font-semibold">
                    {fmt(t.missingLine, { payee: name, amount: formatUsdt(toBase(r.recurring.amountUsdt), { decimals: 0 }), every: every[r.recurring.every], name: r.beneficiaryLabel })}
                  </p>
                  <Button small variant="secondary" className="mt-1.5" onClick={() => onRequest(index)} aria-label={`${t.onRequest}: ${fmt(t.onRequestSr, { payee: name })}`}>
                    {t.onRequest}
                  </Button>
                </li>
              );
            })}
          </ul>
          <Button small className="mt-3" onClick={onPractice}>{t.practice}</Button>
          <p className="mt-1 text-ink-2">{t.practiceNote}</p>
          <p className="mt-3 font-semibold">{t.stepsTitle}</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-ink-2">{t.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        </Notice>
      )}
      {!missing.length && made.length > 0 && <p className="text-small text-ink-2">{fmt(t.willMake, { names: made.join(", ") })}</p>}
    </div>
  );
}
