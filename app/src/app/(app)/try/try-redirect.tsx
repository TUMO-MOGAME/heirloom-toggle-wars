"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ButtonLink, Card } from "@/components/ui/primitives";
import { useWallet } from "@/lib/hooks/wallet-source";
import { useEstate } from "@/lib/hooks/estate";
import { chainConfig } from "@/lib/chain/config";
import { firstDemoPersona, isFreshDemoVisit } from "@/lib/service/fresh-visit";
import type { TryCopy } from "@/content/try";
import { demoOwner, TRY_TARGET, tryStep } from "./try-plan";

/** Makes this browser a new demo owner with no plan, then replaces /try with the plan builder. */
export function TryRedirect({ copy }: { copy: TryCopy }) {
  const router = useRouter();
  const wallet = useWallet();
  const { resetDemo } = useEstate();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    const step = tryStep({ mock: chainConfig.dataMode === "mock", freshVisit: isFreshDemoVisit() });
    if (step === "go") {
      started.current = true;
      router.replace(TRY_TARGET);
      return;
    }
    // The demo personas come from the wallet; wait for them before choosing the owner.
    if (!wallet.ready) return;
    started.current = true;
    const owner = demoOwner(wallet.sessions, firstDemoPersona());
    void (async () => {
      try {
        await resetDemo("fresh");
        if (owner) wallet.switchTo(owner.address);
      } finally {
        router.replace(TRY_TARGET);
      }
    })();
  }, [router, wallet, resetDemo]);

  return (
    <div className="mx-auto w-full max-w-xl">
      <Card>
        <p role="status" aria-live="polite" className="font-sans text-body font-semibold">{copy.opening}</p>
        <p className="mt-1 text-small text-ink-2">{copy.body}</p>
        {/* Without JavaScript (or if it is slow) the link still works: ?demo=fresh resets the simulated estate. */}
        <ButtonLink href={`${TRY_TARGET}?demo=fresh`} variant="secondary" className="mt-4">{copy.cta}</ButtonLink>
      </Card>
    </div>
  );
}
