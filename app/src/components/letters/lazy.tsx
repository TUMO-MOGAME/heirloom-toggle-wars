"use client";
/**
 * Letters on shared screens, loaded after the page itself (plan.md §16.9): the "you have a letter" moment on /family,
 * /estate and the chat home, and the owner's card on /will. Each loads its own small chunk; the letters service
 * loads only when one of them asks for letters, so /estate, /will and /family carry no letters code on first load.
 */
import dynamic from "next/dynamic";

export const LetterMoment = dynamic(() => import("./letter-moment").then((m) => m.LetterMoment), { ssr: false });
export const WillLettersCard = dynamic(() => import("./will-card").then((m) => m.WillLettersCard), { ssr: false });
