"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { ShieldX } from "@/components/ui/icons";
import { useCopy } from "./copy";

/** Not the contract's refusals: these never say that a rule did its job. */
const NOT_A_RULE = new Set(["generic", "cancelled", "NotConfirmed", "sale_changed", "stale_sale", "agent_limit", "bad_sale_tx", "rate_limited", "RulesIncomplete", "ReviewPending", "StaleApp", "ProgramMismatch", "program_mismatch", "has_usdt_account", "unneeded_signer", "members_only", "storage_full", "daily_limit", "unconfirmed", "NotConfirmed", "FileType", "FileSize", "FileEmpty", "DeclineUnknown"]);

/** Shown when the estate's on-chain rules refuse an action, or it didn't complete. */
export function Blocked({ code, message, children }: { code: string; message: string; children?: ReactNode }) {
  const { common } = useCopy();
  const b = common.blocked;
  const rule = !NOT_A_RULE.has(code);
  const ref = useRef<HTMLDivElement>(null);
  // A refusal must never be missed below the fold.
  useEffect(() => { ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [code, message]);
  return (
    <div
      ref={ref}
      role="alert"
      className="refuse rounded-lg border-2 border-l-[10px] border-ink bg-surface p-4"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-[3px] bg-ink text-bg"><ShieldX className="size-6" aria-hidden="true" /></span>
        <div className="min-w-0">
          <p className="inline-block rounded-[3px] bg-ink px-2 py-0.5 text-small font-bold uppercase tracking-[0.12em] text-bg">{rule ? b.title : b.failed}</p>
          <p className="mt-1.5 text-lead font-semibold">{message}</p>
          {rule && <p className="mt-1 text-small text-ink-2">{b.body}</p>}
          {rule && <p className="mt-2 text-[0.75rem] text-ink-2">{b.code}: <span className="font-mono font-semibold text-ink">{code}</span></p>}
          {children && <div className="mt-3 flex flex-wrap gap-2">{children}</div>}
        </div>
      </div>
    </div>
  );
}
