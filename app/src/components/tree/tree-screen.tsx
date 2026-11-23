"use client";
/**
 * /tree: the Trust Tree (plan.md §15). The heading is server-rendered; the tree itself (map, timeline, animation)
 * loads with next/dynamic after the first paint, so the first screen never waits on it. Family only: wallets with a
 * role in the estate. A buyer (or the agent) gets a short explanation instead.
 */
import dynamic from "next/dynamic";
import { UsersRound } from "@/components/ui/icons";
import { ButtonLink, EmptyState, Eyebrow } from "@/components/ui/primitives";
import { Marked } from "@/components/ui/marked";
import { Gate } from "@/components/shell/gate";
import { useLocalized } from "@/lib/i18n/client";
import type { TreeCopy } from "@/content/tree";
import type { Role } from "@/lib/types";
import { TreeSkeleton } from "./skeleton";

const TreeView = dynamic(() => import("./tree-view"), { ssr: false, loading: () => <TreeSkeleton label="" /> });

/** Roles that see the tree: everyone named in the plan. */
const FAMILY: Role[] = ["owner", "beneficiary", "verifier", "monitor"];

export function TreeScreen({ copy: english }: { copy: TreeCopy }) {
  const copy = useLocalized(english, (t) => t.tree);
  return (
    <article aria-labelledby="tree-title" className="print-sheet mx-auto grid w-full max-w-6xl gap-5 *:min-w-0">
      <header className="min-w-0">
        <Eyebrow>{copy.eyebrow}</Eyebrow>
        <h1 id="tree-title" className="mt-1 text-h1"><Marked text={copy.title} /></h1>
        <p className="mt-2 text-lead text-ink-2">{copy.line}</p>
      </header>
      <Gate frame={<TreeSkeleton label={copy.loading} />}>
        {({ snap, role }) => (FAMILY.includes(role) && snap
          ? <TreeView copy={copy} snap={snap} role={role} />
          : (
            <EmptyState
              icon={<UsersRound className="size-6" aria-hidden="true" />}
              title={copy.noRole.title} body={copy.noRole.body}
              action={<ButtonLink href="/estate" variant="secondary">{copy.noRole.back}</ButtonLink>}
            />
          ))}
      </Gate>
    </article>
  );
}
