import { afterEach, describe, expect, it, vi } from "vitest";
import { compareInvoice, invoiceReadingSchema, invoiceReadSchema, normRef, sameName, zarToUsdt, type InvoiceReading } from "./invoice";
import { billDetailsSchema, billPayeeInputSchema, billPayeeStore, billActivityText, DEMO_BILL_PAYEES, payeesAsRecipients, upsertPayee } from "./payees";
import { demoInvoiceReading } from "./demo";
import { parseIntentFallback, planSend, type RecipientLike } from "../assistant/intent";
import { billFor, describeResult, interpretRequest } from "../assistant/client";
import { assistant } from "@/content/assistant";
import { jsonSchemaOf } from "../agent/gemini";
import { createMockService, DEMO_PERSONAS } from "../service/mock";
import { publicSnapshot } from "../audit";
import type { HeirloomService } from "../service";
import type { BillDetails } from "./types";

const RATE = 18.5;
const NDLOVU: InvoiceReading = {
  isInvoice: true, payeeName: "Ndlovu Attorneys Inc.", amount: 2500, currency: "ZAR", reference: "NA-2026-114",
  description: "Drafting of last will and testament", redFlags: [], confidence: 0.94,
};
const typed = (over: Partial<Parameters<typeof compareInvoice>[1]> = {}) => ({ payee: "Ndlovu Attorneys", amountUsdt: zarToUsdt(2500, RATE), amountZar: 2500, reference: "NA-2026-114", ...over });

describe("compareInvoice (the invoice check: the AI recommends, the owner decides)", () => {
  it("matches when payee, rand amount and reference agree (Inc., case and dashes ignored)", () => {
    expect(compareInvoice(NDLOVU, typed({ reference: "na 2026 114" }), RATE)).toEqual({ status: "match", issues: [] });
  });
  it("flags a different rand amount plainly, with both amounts", () => {
    const r = compareInvoice({ ...NDLOVU, amount: 2875 }, typed(), RATE);
    expect(r.status).toBe("mismatch");
    expect(r.issues).toEqual([{ field: "amount", level: "mismatch", invoice: "R2 875", typed: "R2 500" }]);
  });
  it("allows R1 of rounding when rand was typed", () => {
    expect(compareInvoice({ ...NDLOVU, amount: 2500.8 }, typed(), RATE).status).toBe("match");
  });
  it("compares a USD₮ amount with a rand invoice at the live rate, within 1%", () => {
    expect(compareInvoice(NDLOVU, typed({ amountZar: null, amountUsdt: 135.5 }), RATE).status).toBe("match"); // 2 506.75
    expect(compareInvoice(NDLOVU, typed({ amountZar: null, amountUsdt: 100 }), RATE).issues[0]).toMatchObject({ field: "amount", typed: "100 USD₮" });
  });
  it("says it cannot compare when there is no rate and USD₮ was typed", () => {
    const r = compareInvoice(NDLOVU, typed({ amountZar: null, amountUsdt: 135 }), null);
    expect(r.status).toBe("match");
    expect(r.issues).toEqual([{ field: "amount", level: "info", reason: "rate", invoice: "R2 500" }]);
  });
  it("compares a USD₮ invoice directly", () => {
    const usd = { ...NDLOVU, amount: 135, currency: "USDT" as const };
    expect(compareInvoice(usd, typed({ amountZar: null, amountUsdt: 135 }), RATE).status).toBe("match");
    expect(compareInvoice(usd, typed({ amountZar: null, amountUsdt: 140 }), RATE).status).toBe("mismatch");
  });
  it("does not compare another currency's amount", () => {
    expect(compareInvoice({ ...NDLOVU, currency: "other" }, typed(), RATE).issues).toEqual([{ field: "amount", level: "info", reason: "currency" }]);
  });
  it("flags a different payee", () => {
    const r = compareInvoice(NDLOVU, typed({ payee: "Soweto Plumbing" }), RATE);
    expect(r.status).toBe("mismatch");
    expect(r.issues[0]).toEqual({ field: "payee", level: "mismatch", invoice: "Ndlovu Attorneys Inc.", typed: "Soweto Plumbing" });
  });
  it("flags a different reference, and suggests the invoice's when none was typed", () => {
    expect(compareInvoice(NDLOVU, typed({ reference: "NA-2026-115" }), RATE).issues[0]).toMatchObject({ field: "reference", level: "mismatch" });
    const r = compareInvoice(NDLOVU, typed({ reference: null }), RATE);
    expect(r.status).toBe("match");
    expect(r.issues).toEqual([{ field: "reference", level: "info", reason: "addReference", invoice: "NA-2026-114" }]);
  });
  it("does not compare a file that is not an invoice, or one read with low confidence", () => {
    expect(compareInvoice({ ...NDLOVU, isInvoice: false }, typed(), RATE)).toEqual({ status: "unread", issues: [{ field: "document", level: "info", reason: "notInvoice" }] });
    expect(compareInvoice({ ...NDLOVU, confidence: 0.3 }, typed(), RATE).status).toBe("unread");
  });
  it("reports every disagreement at once", () => {
    const r = compareInvoice({ ...NDLOVU, amount: 2875 }, typed({ payee: "Dlamini & Co", reference: "X1" }), RATE);
    expect(r.issues.map((i) => i.field)).toEqual(["payee", "amount", "reference"]);
  });
});

describe("name and reference matching", () => {
  it.each([
    ["Ndlovu Attorneys", "Ndlovu Attorneys Inc.", true],
    ["Ndlovu Attorneys Inc", "NDLOVU ATTORNEYS", true],
    ["Westerford High School", "Westerford High", true],
    ["Ndlovu Attorneys", "Dlamini Attorneys", false],
    ["", "Ndlovu", false],
  ])("%s ~ %s → %s", (a, b, same) => expect(sameName(a, b)).toBe(same));
  it("normalises references", () => expect(normRef(" na-2026/114 ")).toBe("NA2026114"));
});

describe("invoice schemas", () => {
  it("accepts a reading and rejects a negative amount or a bad currency", () => {
    expect(invoiceReadingSchema.parse(NDLOVU)).toEqual(NDLOVU);
    expect(invoiceReadingSchema.safeParse({ ...NDLOVU, amount: -5 }).success).toBe(false);
    expect(invoiceReadingSchema.safeParse({ ...NDLOVU, currency: "EUR" }).success).toBe(false);
    expect(invoiceReadingSchema.safeParse({ ...NDLOVU, confidence: 2 }).success).toBe(false);
  });
  it("needs a SHA-256 hash and a known engine on the answer", () => {
    expect(invoiceReadSchema.safeParse({ reading: NDLOVU, sha256: "a".repeat(64), engine: "ai" }).success).toBe(true);
    expect(invoiceReadSchema.safeParse({ reading: NDLOVU, sha256: "nope", engine: "ai" }).success).toBe(false);
    expect(invoiceReadSchema.safeParse({ reading: NDLOVU, sha256: "a".repeat(64), engine: "magic" }).success).toBe(false);
  });
  it("turns into a JSON schema Gemini accepts (no maxItems)", () => {
    const s = JSON.stringify(jsonSchemaOf(invoiceReadingSchema));
    expect(s).not.toContain("maxItems");
    expect(s).toContain("payeeName");
  });
  it("bill details: a hash must be a SHA-256, never a file", () => {
    const ok: BillDetails = { payee: "Ndlovu Attorneys", kind: "lawyer", reference: null, note: "the will", amountZar: 2500, invoiceSha256: "b".repeat(64), invoiceCheck: "match" };
    expect(billDetailsSchema.parse(ok)).toEqual(ok);
    expect(billDetailsSchema.safeParse({ ...ok, invoiceSha256: "data:application/pdf;base64,AAAA" }).success).toBe(false);
    expect(billDetailsSchema.safeParse({ ...ok, kind: "vault" }).success).toBe(false);
  });
});

describe("saved bill payees", () => {
  const wallet = DEMO_BILL_PAYEES[0].wallet;
  it("validates name, wallet and kind", () => {
    expect(billPayeeInputSchema.safeParse({ name: "Ndlovu Attorneys", wallet, kind: "lawyer" }).success).toBe(true);
    expect(billPayeeInputSchema.safeParse({ name: "N", wallet, kind: "lawyer" }).success).toBe(false);
    expect(billPayeeInputSchema.safeParse({ name: "Ndlovu", wallet: "0xdeadbeef", kind: "lawyer" }).success).toBe(false);
    expect(billPayeeInputSchema.safeParse({ name: "Ndlovu", wallet, kind: "casino" }).success).toBe(false);
  });
  it("keeps one entry per wallet (saving again updates it)", () => {
    const a = upsertPayee([], { name: "Ndlovu", wallet, kind: "lawyer" });
    const b = upsertPayee(a.list, { name: "Ndlovu Attorneys", wallet, kind: "lawyer", reference: "MOK-1" });
    expect(b.list).toHaveLength(1);
    expect(b.payee).toMatchObject({ id: a.payee.id, name: "Ndlovu Attorneys", reference: "MOK-1" });
  });
  it("device store keeps each wallet's payees apart", () => {
    const mem = new Map<string, string>();
    const store = billPayeeStore({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) });
    store.save("OwnerA", { name: "Soweto Plumbing", wallet, kind: "plumber" });
    expect(store.list("OwnerA").map((p) => p.name)).toEqual(["Soweto Plumbing"]);
    expect(store.list("OwnerB")).toEqual([]);
    expect(billPayeeStore({ getItem: (k) => mem.get(k) ?? null, setItem: () => undefined }).list("OwnerA")).toHaveLength(1);
  });
  it("demo payees have valid wallets", () => {
    for (const p of DEMO_BILL_PAYEES) expect(billPayeeInputSchema.safeParse(p).success).toBe(true);
  });
  it("activity line names the payee, what it was for and the reference", () => {
    expect(billActivityText("Thabo", { payee: "Ndlovu Attorneys", kind: "lawyer", reference: "NA-2026-114", note: "the will", amountZar: 2500, invoiceSha256: null, invoiceCheck: null }, "135.14 USD₮"))
      .toBe("Thabo paid a bill: 135.14 USD₮ to Ndlovu Attorneys (the will, ref NA-2026-114)");
  });
});

describe("chat: \"Pay Ndlovu Attorneys R2 500 for the will\"", () => {
  const FAMILY: RecipientLike[] = [
    { label: "Lerato Mokoena", address: "LeRaTo1111111111111111111111111111111111111", relationship: "daughter, 20" },
    { label: "Adv. Thandi Ndlovu", address: "ThAndi1111111111111111111111111111111111111", relationship: "executor" },
  ];
  const all = [...FAMILY, ...payeesAsRecipients(DEMO_BILL_PAYEES)];

  it("reads the firm (not Adv. Ndlovu), the rand amount with a space and the memo", () => {
    expect(parseIntentFallback("Pay Ndlovu Attorneys R2 500 for the will", all)).toEqual({
      action: "send", recipient: "Ndlovu Attorneys", amountUsdt: null, amountZar: 2500, memo: "the will",
    });
    const plan = planSend(parseIntentFallback("Pay Ndlovu Attorneys R2 500 for the will", all), all, RATE);
    expect(plan).toMatchObject({ ok: true, to: DEMO_BILL_PAYEES[0].wallet, amountUsdt: zarToUsdt(2500, RATE) });
  });
  it("finds a payee by kind: \"pay the plumber R1 850\"", () => {
    const plan = planSend(parseIntentFallback("pay the plumber R1 850", all), all, RATE);
    expect(plan).toMatchObject({ ok: true, to: DEMO_BILL_PAYEES[1].wallet });
  });

  afterEach(() => vi.unstubAllGlobals());
  it("interpretRequest marks it as a bill and builds the bill details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); })); // the fallback parser runs on the device
    const service = {
      savedRecipients: async () => FAMILY.map((f) => ({ ...f })),
      billPayees: async () => DEMO_BILL_PAYEES,
      getFx: async () => ({ usdtZar: RATE, source: "t", fetchedAt: 0 }),
    } as unknown as HeirloomService;
    const r = await interpretRequest("Pay Ndlovu Attorneys R2 500 for the will", service, RATE, assistant.wallet);
    expect(r.bill?.id).toBe("bp_ndlovu");
    expect(billFor(r)).toEqual({ payee: "Ndlovu Attorneys", kind: "lawyer", reference: null, note: "the will", amountZar: 2500, invoiceSha256: null, invoiceCheck: null });
    expect(describeResult(r, assistant.wallet)).toMatch(/^I read this as a bill: R2\s500/);
    // A family send stays a family send.
    const fam = await interpretRequest("Send R500 to Lerato for books", service, RATE, assistant.wallet);
    expect(fam.bill).toBeUndefined();
    expect(billFor(fam)).toBeUndefined();
  });
  it("still works with a service that has no bill payees", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const service = { savedRecipients: async () => FAMILY, getFx: async () => ({ usdtZar: RATE, source: "t", fetchedAt: 0 }) } as unknown as HeirloomService;
    const r = await interpretRequest("Send R500 to Lerato", service, RATE, assistant.wallet);
    expect(r.plan.ok).toBe(true);
  });
});

describe("demo invoice reader (scripted by file name, labelled on screen)", () => {
  it.each([
    ["6-invoice-ndlovu-attorneys.pdf", 2500, true],
    ["6-invoice-ndlovu-attorneys-vat.pdf", 2875, true],
    ["plumbing-invoice.jpg", 1850, true],
    ["school-trip.png", 300, true],
    ["grocery-slip.jpg", null, false],
  ])("%s", (name, amount, isInvoice) => {
    const r = demoInvoiceReading(name);
    expect(invoiceReadingSchema.parse(r)).toEqual(r);
    expect(r.amount).toBe(amount);
    expect(r.isInvoice).toBe(isInvoice);
  });
});

describe("mock: Thabo pays Ndlovu Attorneys for drafting the will (own wallet, not the vault)", () => {
  afterEach(() => vi.restoreAllMocks());
  const thabo = DEMO_PERSONAS.find((p) => p.key === "thabo")!;

  it("reads the invoice, reviews as a bill, pays once, and shows it in bills and activity but not the public record", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    svc.setActor({ address: thabo.address, role: thabo.role, label: thabo.label });
    const [{ estate }] = await svc.listEstatesFor(thabo.address);
    const vaultBefore = (await svc.getEstate(estate)).estate.vaultBalance;
    const walletBefore = svc.balanceOf(thabo.address)!;

    const payees = await svc.billPayees();
    expect(payees.map((p) => p.name)).toEqual(["Ndlovu Attorneys", "Soweto Plumbing", "Westerford High School"]);
    const ndlovu = payees[0];

    const read = await svc.readInvoice(new File(["%PDF-1.4 demo invoice"], "6-invoice-ndlovu-attorneys.pdf", { type: "application/pdf" }));
    expect(read.engine).toBe("demo");
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
    const check = compareInvoice(read.reading, { payee: ndlovu.name, amountUsdt: zarToUsdt(2500, RATE), amountZar: 2500, reference: "NA-2026-114" }, RATE);
    expect(check.status).toBe("match");

    const bill: BillDetails = { payee: ndlovu.name, kind: "lawyer", reference: "NA-2026-114", note: "Drafting the will", amountZar: 2500, invoiceSha256: read.sha256, invoiceCheck: check.status };
    const review = await svc.reviewSend({ to: ndlovu.wallet, toLabel: ndlovu.name, amountUsdt: 135, bill });
    expect(review).toMatchObject({ kind: "bill", from: thabo.address, toLabel: "Ndlovu Attorneys", bill });
    expect(review.warnings.join(" ")).not.toMatch(/not sent to this address before/); // a saved payee is known

    const first = await svc.confirmSend(review);
    const again = await svc.confirmSend(review); // pay-once: a retry returns the same receipt
    expect(again.signature).toBe(first.signature);
    expect(svc.balanceOf(thabo.address)).toBe(walletBefore - review.amount);

    const pending = await svc.paidBills();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 10_000); // "the network" confirms
    const [paid] = await svc.paidBills();
    expect(paid).toMatchObject({ status: "confirmed", bill: { payee: "Ndlovu Attorneys", reference: "NA-2026-114", invoiceSha256: read.sha256 } });
    expect(svc.balanceOf(ndlovu.wallet)).toBe(review.amount);

    const snap = await svc.getEstate(estate);
    expect(snap.estate.vaultBalance).toBe(vaultBefore); // the vault is not touched
    const line = snap.activity.find((a) => a.kind === "BillPaid");
    expect(line?.text).toBe("Thabo paid a bill: 135 USD₮ to Ndlovu Attorneys (Drafting the will, ref NA-2026-114)");
    expect(publicSnapshot(snap).activity.some((a) => a.kind === "BillPaid")).toBe(false);
  });

  it("saves a new payee for this wallet only, and refuses a bad wallet", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    svc.setActor({ address: thabo.address, role: thabo.role, label: thabo.label });
    const saved = await svc.saveBillPayee({ name: "Dr. Naidoo Rooms", wallet: "DrNaiDooRooMs5uE6rAoPaYbiLL4xyzABCDEFGHJKLMN", kind: "doctor" });
    expect((await svc.billPayees()).some((p) => p.id === saved.id)).toBe(true);
    await expect(svc.saveBillPayee({ name: "Bad", wallet: "not-a-wallet", kind: "other" })).rejects.toThrow();
    const lerato = DEMO_PERSONAS.find((p) => p.key === "lerato")!;
    svc.setActor({ address: lerato.address, role: lerato.role, label: lerato.label });
    expect(await svc.billPayees()).toEqual([]);
  });

  it("a plain family send is unchanged", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    svc.setActor({ address: thabo.address, role: thabo.role, label: thabo.label });
    const lerato = DEMO_PERSONAS.find((p) => p.key === "lerato")!;
    const r = await svc.reviewSend({ to: lerato.address, toLabel: "Lerato", amountUsdt: 10 });
    expect(r.kind).toBe("p2p");
    expect(r.bill).toBeUndefined();
    await svc.confirmSend(r);
    expect(await svc.paidBills()).toEqual([]);
  });
});
