import { Skeleton } from "@/components/ui/primitives";

/** The tree's place while it loads (kept out of the tree chunk, so the page can show it at once). */
export function TreeSkeleton({ label }: { label: string }) {
  return (
    <div className="grid gap-4" role={label ? "status" : undefined} aria-label={label || undefined} aria-busy="true">
      <Skeleton className="h-36 w-full rounded-lg!" />
      <Skeleton className="h-[26rem] w-full rounded-lg!" />
    </div>
  );
}
