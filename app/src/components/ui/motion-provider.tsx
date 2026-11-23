"use client";
import type { ReactNode } from "react";
import { LazyMotion, MotionConfig } from "motion/react";

const features = () => import("./motion-features").then((m) => m.default);

/**
 * Wraps each part of the app that animates with the motion library (toasts, the agent sheet, the add-asset form and
 * the less-visited screens). Only those parts import it, so the pages people open first (/, /chat, /estate, /will,
 * /car) never download or run motion: their entrances are CSS (globals.css: .enter, .spring-pop, .beat...).
 * Every animated element is an `m.*` component; the animation features are fetched once, after the part mounts.
 * Reduced motion follows the device setting.
 */
export function MotionScope({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={features}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
