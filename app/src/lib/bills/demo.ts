/**
 * Demo mode's scripted invoice reader: no AI runs on the public demo, so the "reading" is chosen by file name,
 * like the scripted document reviewer, and the screen labels it as a demo answer.
 * docs/demo-documents/{accepted,rejected}/6-invoice-* are the matching sample files.
 */
import type { InvoiceReading } from "./invoice";

const NDLOVU = { isInvoice: true, payeeName: "Ndlovu Attorneys Inc.", currency: "ZAR", reference: "NA-2026-114", redFlags: [], confidence: 0.94 } as const;

export function demoInvoiceReading(fileName: string): InvoiceReading {
  const n = fileName.toLowerCase();
  if (/grocery|slip|till|selfie|fake|blank/.test(n)) {
    return { isInvoice: false, payeeName: null, amount: null, currency: null, reference: null, description: "A shop till slip, not an invoice", redFlags: ["This is not an invoice or a quote."], confidence: 0.9 };
  }
  if (/plumb|geyser/.test(n)) {
    return { isInvoice: true, payeeName: "Soweto Plumbing", amount: 1850, currency: "ZAR", reference: "INV-0420", description: "Burst geyser pipe: call-out and repair", redFlags: [], confidence: 0.92 };
  }
  if (/trip|school|westerford/.test(n)) {
    return { isInvoice: true, payeeName: "Westerford High School", amount: 300, currency: "ZAR", reference: "NALEDI-M", description: "Grade 9 trip to the Cradle of Humankind", redFlags: [], confidence: 0.93 };
  }
  if (/vat|2875|different|changed/.test(n)) {
    return { ...NDLOVU, redFlags: [], amount: 2875, description: "Drafting of last will and testament, R2 500 plus VAT" };
  }
  return { ...NDLOVU, redFlags: [], amount: 2500, description: "Drafting of last will and testament" };
}
