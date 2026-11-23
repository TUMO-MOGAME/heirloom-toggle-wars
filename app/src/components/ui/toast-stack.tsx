"use client";
import clsx from "clsx";
import { AnimatePresence, m as motion } from "motion/react";
import { MotionScope } from "@/components/ui/motion-provider";
import { Check, CircleAlert, Info, X } from "@/components/ui/icons";
import type { useEstate } from "@/lib/hooks/estate";

type Toast = ReturnType<typeof useEstate>["toasts"][number];

/**
 * The toasts themselves, with motion for their exit. Loaded by <Toaster> (ui/client.tsx) only once a first toast
 * exists, so the motion library stays out of every page's first load. Brings its own <MotionScope>.
 */
export function ToastStack(props: Parameters<typeof ToastStackBody>[0]) {
  return <MotionScope><ToastStackBody {...props} /></MotionScope>;
}

function ToastStackBody({ toasts, dismiss, dismissLabel }: { toasts: Toast[]; dismiss: (id: Toast["id"]) => void; dismissLabel: string }) {
  return (
    <AnimatePresence>
      {toasts.map((t) => (
        <motion.div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.22 }}
          className={clsx(
            "pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-md p-3 pr-1.5 text-small shadow-raised",
            // error: heavy rule and warning icon; ok: solid inverted block and tick; info: hairline outline
            t.tone === "error" ? "border-2 border-l-8 border-ink bg-surface text-ink" : t.tone === "ok" ? "brand-panel border border-ink" : "border border-ink bg-surface text-ink",
          )}
        >
          <span className="mt-0.5 shrink-0">
            {t.tone === "error" ? <CircleAlert className="size-5" aria-hidden="true" /> : t.tone === "ok" ? <Check className="size-5" aria-hidden="true" /> : <Info className="size-5" aria-hidden="true" />}
          </span>
          <p className="min-w-0 flex-1 py-0.5 font-medium">{t.text}</p>
          <button type="button" onClick={() => dismiss(t.id)} aria-label={dismissLabel} className="grid size-11 shrink-0 place-items-center rounded-full text-ink hover:bg-surface-2">
            <X className="size-4" aria-hidden="true" />
          </button>
        </motion.div>
      ))}
    </AnimatePresence>
  );
}
