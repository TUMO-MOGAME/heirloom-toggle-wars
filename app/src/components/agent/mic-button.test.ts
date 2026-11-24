/**
 * Voice typing in the composers: the words are added to what is already typed (never replacing it, never sent), and
 * both composers show the microphone with its language and a live status region.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { appendTranscript } from "./mic-button";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }), usePathname: () => "/" }));

describe("appendTranscript", () => {
  it("adds the words after what is typed, with one space", () => {
    expect(appendTranscript("", "Pay the school fees")).toBe("Pay the school fees");
    expect(appendTranscript("My plan:  ", " Pay the school fees ")).toBe("My plan: Pay the school fees");
    expect(appendTranscript("Keep this", "   ")).toBe("Keep this");
  });
});

describe("the plan builder's composer", () => {
  it("shows the microphone beside the send button, with its language and a live status", async () => {
    const { Composer } = await import("./chat-parts");
    const onSend = vi.fn();
    const html = renderToStaticMarkup(createElement(Composer, { onSend, copy: { placeholder: "Type", inputLabel: "Message", send: "Send" } }));
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Speak instead of typing \(English\)"/);
    expect(html.indexOf("Speak instead of typing")).toBeLessThan(html.indexOf('aria-label="Send"'));
    expect(html).toContain('role="status"');
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("both composers only put the words in the box", () => {
  // Without a DOM to click in, read the wiring: the transcript callback sets the box's value and focuses it; sending
  // stays with the person's own Enter or send button.
  for (const file of ["../chat/chat-composer.tsx", "./chat-parts.tsx"]) {
    it(file, () => {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      const heard = src.slice(src.indexOf("const heard = useCallback"), src.indexOf("}, []);", src.indexOf("const heard = useCallback")));
      expect(heard).toContain("setValue((v) => appendTranscript(v, text))");
      expect(heard).toContain("focus()");
      expect(heard).not.toMatch(/onSend|submit/);
      expect(src).toContain("useMicButton({ onText: heard");
      expect(src).not.toMatch(/SpeechRecognition|speechSynthesis/);
    });
  }
});
