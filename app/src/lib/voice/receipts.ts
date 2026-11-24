/**
 * Spoken receipts for on-chain payments (plan §20.1 item 3). When the program pays out (a claim paid to an institution,
 * a scheduled payment, the fallback plan, the residual sweep, a sale settling), the family can hear it in their own
 * language: "1500 USD₮ (about R26 800) was paid to University of Cape Town for Lerato's tuition on 24 November."
 *
 * Shared by browser and server (no React, no server code). The words come ONLY from the payment's own facts, which the
 * server works out itself (lib/voice/server/receipt.ts): from the transaction on devnet, or from the demo's fixed data.
 * The browser never sends text: on devnet it sends a signature, in the demo a `demo.` receipt id whose every part is
 * a key into the fixed tables below (DEMO_RECEIPT_PAYEES, DEMO_RECEIPT_PEOPLE), an amount and a time.
 *
 * Each language has one fixed template per payment kind. `translated: "machine"` marks templates that still need a
 * first-language speaker's read (plan §20.2). Languages whose `support.speech` flag is false get the words as text only.
 */
import type { ActivityItem, Base58, Category } from "../types";
import { DEMO_PAYEES } from "../service/mock-payees";
import { DEMO_PERSONAS } from "../wallet/personas";
import { STATEMENT_TZ } from "../everyday/statement";
import { VOICE_LANGUAGES, type VoiceLanguage } from "./languages";

/** Bumped whenever a template's words change, so cached audio of the old words is never served. */
export const RECEIPT_TEMPLATE_VERSION = "r1";

/**
 * The confirmation chime (ElevenLabs Sound Effects, made once by scripts/make-chime.ts --send and shipped as a static
 * file). Null until that file is committed: the button then plays the receipt without a chime (no 404 in the console).
 */
export const PAYMENT_CHIME_SRC: string | null = "/audio/payment-chime.mp3";

export type ReceiptKind = "claim" | "scheduled" | "fallback" | "sweep" | "sale";

/** Program events that move USD₮ out of the vault (or, for a sale, into it or to a family member). */
export const RECEIPT_EVENTS: Record<string, ReceiptKind> = {
  ClaimPaid: "claim",
  ScheduledPaid: "scheduled",
  FallbackExecuted: "fallback",
  ResidualSwept: "sweep",
  AssetSold: "sale",
};

export const receiptKindOf = (eventKind: string): ReceiptKind | null => RECEIPT_EVENTS[eventKind] ?? null;

/** Who was paid, when there is no public name to say. */
export type ReceiptRole = "payee" | "landlord" | "ownWallet" | "family" | "recipient" | "vault";
export type ReceiptParty = { name: string } | { role: ReceiptRole };
export type ReceiptAsset = "car" | "motorbike" | "asset";

/** Everything a receipt says. Built on the server only, from the chain or the demo's fixed data. */
export interface ReceiptFacts {
  kind: ReceiptKind;
  /** USD₮ base units. */
  amount: bigint;
  /** Unix seconds. */
  ts: number;
  /** Who was paid; for a sale, where the money went. */
  to: ReceiptParty;
  /** The rule's category (claims and scheduled payments). */
  purpose?: Category;
  /** Whose rule it was: a first name, only where the record already shows it (the demo). Never on devnet. */
  person?: string;
  /** What was sold (sales). */
  asset?: ReceiptAsset;
  /** Rand per USD₮, when known; the receipt then gives the rand amount too. */
  usdtZar?: number | null;
}

/** Already formatted pieces a template puts together. */
interface Parts {
  amount: string;
  /** " (about R26 800)", or "" when the rate is not known. */
  zar: string;
  /** "to University of Cape Town", "into the estate's vault". */
  to: string;
  /** "for Lerato's tuition", "for books", or "". */
  for: string;
  date: string;
  asset: ReceiptAsset;
}

interface LanguageTemplates {
  translated: "human" | "machine";
  /** Intl locale for numbers and dates. */
  intl: string;
  /** Rand amounts shown with the R sign (South African languages) rather than the currency's name. */
  randSign?: boolean;
  about: (zar: string) => string;
  to: (name: string) => string;
  roles: Record<ReceiptRole, string>;
  purpose: Record<Category, string>;
  forWhat: (purpose: string, person?: string) => string;
  sentence: Record<ReceiptKind, (p: Parts) => string>;
}

const T: Record<VoiceLanguage, LanguageTemplates> = {
  en: {
    translated: "human", intl: "en-ZA", randSign: true,
    about: (z) => ` (about ${z})`,
    to: (n) => `to ${n}`,
    roles: { payee: "to an approved payee", landlord: "to an approved landlord", ownWallet: "to a family member's own wallet", family: "to a family member", recipient: "to the named recipient", vault: "into the estate's vault" },
    purpose: { Tuition: "tuition", Accommodation: "accommodation", Books: "books", Medical: "medical care", General: "everyday costs" },
    forWhat: (p, who) => (who ? `for ${who}'s ${p}` : `for ${p}`),
    sentence: {
      claim: (p) => `${p.amount}${p.zar} was paid ${p.to} ${p.for} on ${p.date}.`,
      scheduled: (p) => `A scheduled payment of ${p.amount}${p.zar} was paid ${p.to} ${p.for} on ${p.date}.`,
      fallback: (p) => `Under the fallback plan, the whole vault, ${p.amount}${p.zar}, was paid ${p.to} on ${p.date}.`,
      sweep: (p) => `${p.amount}${p.zar} that no rule needed any more was paid ${p.to} on ${p.date}.`,
      sale: (p) => `The ${{ car: "car", motorbike: "motorbike", asset: "asset" }[p.asset]} was sold for ${p.amount}${p.zar} on ${p.date}, and the money was paid ${p.to}.`,
    },
  },
  af: {
    translated: "machine", intl: "af-ZA", randSign: true,
    about: (z) => ` (sowat ${z})`,
    to: (n) => `aan ${n}`,
    roles: { payee: "aan 'n goedgekeurde betaalontvanger", landlord: "aan 'n goedgekeurde verhuurder", ownWallet: "in 'n familielid se eie wallet", family: "aan 'n familielid", recipient: "aan die benoemde ontvanger", vault: "in die boedel se kluis" },
    purpose: { Tuition: "klasgeld", Accommodation: "verblyf", Books: "boeke", Medical: "mediese sorg", General: "alledaagse uitgawes" },
    forWhat: (p, who) => (who ? `vir ${who} se ${p}` : `vir ${p}`),
    sentence: {
      claim: (p) => `${p.amount}${p.zar} is op ${p.date} ${p.to} betaal ${p.for}.`,
      scheduled: (p) => `'n Geskeduleerde betaling van ${p.amount}${p.zar} is op ${p.date} ${p.to} betaal ${p.for}.`,
      fallback: (p) => `Volgens die terugvalplan is die hele kluis, ${p.amount}${p.zar}, op ${p.date} ${p.to} betaal.`,
      sweep: (p) => `${p.amount}${p.zar} wat geen reël meer nodig gehad het nie, is op ${p.date} ${p.to} betaal.`,
      sale: (p) => `${{ car: "Die motor", motorbike: "Die motorfiets", asset: "Die bate" }[p.asset]} is op ${p.date} vir ${p.amount}${p.zar} verkoop, en die geld is ${p.to} betaal.`,
    },
  },
  zu: {
    translated: "machine", intl: "zu-ZA", randSign: true,
    about: (z) => ` (cishe ${z})`,
    to: (n) => `ku-${n}`,
    roles: { payee: "kumamukeli ogunyaziwe", landlord: "kumnikazi wendlu ogunyaziwe", ownWallet: "esikhwameni selungu lomndeni", family: "elungwini lomndeni", recipient: "kumamukeli oqokiwe", vault: "egumbini lokugcina imali yefa" },
    purpose: { Tuition: "imali yesikole", Accommodation: "indawo yokuhlala", Books: "izincwadi", Medical: "ukwelashwa", General: "izindleko zansuku zonke" },
    forWhat: (p, who) => (who ? `ukukhokhela ${p} (${who})` : `ukukhokhela ${p}`),
    sentence: {
      claim: (p) => `Kukhokhwe ${p.amount}${p.zar} ${p.to} ${p.for} ngomhla ka-${p.date}.`,
      scheduled: (p) => `Inkokhelo ehleliwe ka-${p.amount}${p.zar} ikhokhwe ${p.to} ${p.for} ngomhla ka-${p.date}.`,
      fallback: (p) => `Ngokohlelo lwesibili, yonke imali yegumbi lokugcina, ${p.amount}${p.zar}, ikhokhwe ${p.to} ngomhla ka-${p.date}.`,
      sweep: (p) => `Kukhokhwe ${p.amount}${p.zar} ebingasadingwa yimithetho ${p.to} ngomhla ka-${p.date}.`,
      sale: (p) => `${{ car: "Imoto", motorbike: "Isithuthuthu", asset: "Impahla" }[p.asset]} ithengiswe nge-${p.amount}${p.zar} ngomhla ka-${p.date}, imali yakhokhwa ${p.to}.`,
    },
  },
  st: {
    translated: "machine", intl: "st-ZA", randSign: true,
    about: (z) => ` (hoo e ka bang ${z})`,
    to: (n) => `ho ${n}`,
    roles: { payee: "ho molefuwa ya dumeletsweng", landlord: "ho mong'a ntlo ya dumeletsweng", ownWallet: "sepacheng sa setho sa lelapa", family: "ho setho sa lelapa", recipient: "ho moamohedi ya kgethilweng", vault: "polokelong ya lefa" },
    purpose: { Tuition: "ditefello tsa sekolo", Accommodation: "bodulo", Books: "dibuka", Medical: "kalafo", General: "ditshenyehelo tsa letsatsi le letsatsi" },
    forWhat: (p, who) => (who ? `bakeng sa ${p} (${who})` : `bakeng sa ${p}`),
    sentence: {
      claim: (p) => `${p.amount}${p.zar} e lefilwe ${p.to} ${p.for} ka la ${p.date}.`,
      scheduled: (p) => `Tefo e hlophisitsweng ya ${p.amount}${p.zar} e lefilwe ${p.to} ${p.for} ka la ${p.date}.`,
      fallback: (p) => `Ho ya ka moralo wa ho qetela, polokelo yohle, ${p.amount}${p.zar}, e lefilwe ${p.to} ka la ${p.date}.`,
      sweep: (p) => `${p.amount}${p.zar} e neng e sa hlokwe ke molao ofe kapa ofe e lefilwe ${p.to} ka la ${p.date}.`,
      sale: (p) => `${{ car: "Koloi", motorbike: "Sethuthuthu", asset: "Thepa" }[p.asset]} e rekisitswe ka ${p.amount}${p.zar} ka la ${p.date}, mme tjhelete e lefilwe ${p.to}.`,
    },
  },
  fr: {
    translated: "machine", intl: "fr",
    about: (z) => ` (environ ${z})`,
    to: (n) => `à ${n}`,
    roles: { payee: "à un bénéficiaire agréé", landlord: "à un bailleur agréé", ownWallet: "sur le portefeuille d'un membre de la famille", family: "à un membre de la famille", recipient: "au bénéficiaire désigné", vault: "dans le coffre de la succession" },
    purpose: { Tuition: "les frais de scolarité", Accommodation: "le logement", Books: "les livres", Medical: "les soins médicaux", General: "les dépenses courantes" },
    forWhat: (p, who) => (who ? `pour ${p} de ${who}` : `pour ${p}`),
    sentence: {
      claim: (p) => `${p.amount}${p.zar} ont été versés ${p.to} ${p.for} le ${p.date}.`,
      scheduled: (p) => `Un paiement programmé de ${p.amount}${p.zar} a été versé ${p.to} ${p.for} le ${p.date}.`,
      fallback: (p) => `Selon le plan de secours, tout le coffre, soit ${p.amount}${p.zar}, a été versé ${p.to} le ${p.date}.`,
      sweep: (p) => `${p.amount}${p.zar} dont plus aucune règle n'avait besoin ont été versés ${p.to} le ${p.date}.`,
      sale: (p) => `${{ car: "La voiture a été vendue", motorbike: "La moto a été vendue", asset: "Le bien a été vendu" }[p.asset]} pour ${p.amount}${p.zar} le ${p.date}, et l'argent a été versé ${p.to}.`,
    },
  },
  pt: {
    translated: "machine", intl: "pt",
    about: (z) => ` (cerca de ${z})`,
    to: (n) => `a ${n}`,
    roles: { payee: "a um beneficiário aprovado", landlord: "a um senhorio aprovado", ownWallet: "para a carteira de um familiar", family: "a um familiar", recipient: "ao destinatário indicado", vault: "para o cofre do espólio" },
    purpose: { Tuition: "as propinas", Accommodation: "o alojamento", Books: "os livros", Medical: "os cuidados médicos", General: "as despesas do dia a dia" },
    forWhat: (p, who) => (who ? `para ${p} de ${who}` : `para ${p}`),
    sentence: {
      claim: (p) => `${p.amount}${p.zar} foram pagos ${p.to} ${p.for} em ${p.date}.`,
      scheduled: (p) => `Um pagamento agendado de ${p.amount}${p.zar} foi pago ${p.to} ${p.for} em ${p.date}.`,
      fallback: (p) => `Pelo plano de recurso, todo o cofre, ${p.amount}${p.zar}, foi pago ${p.to} em ${p.date}.`,
      sweep: (p) => `${p.amount}${p.zar} de que nenhuma regra precisava foram pagos ${p.to} em ${p.date}.`,
      sale: (p) => `${{ car: "O carro foi vendido", motorbike: "A mota foi vendida", asset: "O bem foi vendido" }[p.asset]} por ${p.amount}${p.zar} em ${p.date}, e o dinheiro foi pago ${p.to}.`,
    },
  },
  es: {
    translated: "machine", intl: "es",
    about: (z) => ` (unos ${z})`,
    to: (n) => `a ${n}`,
    roles: { payee: "a un beneficiario aprobado", landlord: "a un arrendador aprobado", ownWallet: "a la cartera de un familiar", family: "a un familiar", recipient: "al destinatario designado", vault: "a la bóveda del patrimonio" },
    purpose: { Tuition: "la matrícula", Accommodation: "el alojamiento", Books: "los libros", Medical: "la atención médica", General: "los gastos diarios" },
    forWhat: (p, who) => (who ? `para ${p} de ${who}` : `para ${p}`),
    sentence: {
      claim: (p) => `Se pagaron ${p.amount}${p.zar} ${p.to} ${p.for} el ${p.date}.`,
      scheduled: (p) => `Se hizo un pago programado de ${p.amount}${p.zar} ${p.to} ${p.for} el ${p.date}.`,
      fallback: (p) => `Según el plan de respaldo, toda la bóveda, ${p.amount}${p.zar}, se pagó ${p.to} el ${p.date}.`,
      sweep: (p) => `Se pagaron ${p.amount}${p.zar} que ya ninguna regla necesitaba ${p.to} el ${p.date}.`,
      sale: (p) => `${{ car: "El coche se vendió", motorbike: "La moto se vendió", asset: "El bien se vendió" }[p.asset]} por ${p.amount}${p.zar} el ${p.date}, y el dinero se pagó ${p.to}.`,
    },
  },
  ar: {
    translated: "machine", intl: "ar",
    about: (z) => ` (حوالي ${z})`,
    to: (n) => `إلى ${n}`,
    roles: { payee: "إلى جهة دفع معتمدة", landlord: "إلى مؤجر معتمد", ownWallet: "إلى المحفظة الخاصة بأحد أفراد العائلة", family: "إلى أحد أفراد العائلة", recipient: "إلى المستفيد المحدد", vault: "إلى خزنة التركة" },
    purpose: { Tuition: "الرسوم الدراسية", Accommodation: "السكن", Books: "الكتب", Medical: "الرعاية الطبية", General: "المصاريف اليومية" },
    forWhat: (p, who) => (who ? `مقابل ${p} الخاصة بـ ${who}` : `مقابل ${p}`),
    sentence: {
      claim: (p) => `تم دفع ${p.amount}${p.zar} ${p.to} ${p.for} في ${p.date}.`,
      scheduled: (p) => `تم تنفيذ دفعة مجدولة بقيمة ${p.amount}${p.zar} ${p.to} ${p.for} في ${p.date}.`,
      fallback: (p) => `وفق الخطة البديلة، تم دفع كامل الخزنة، ${p.amount}${p.zar}، ${p.to} في ${p.date}.`,
      sweep: (p) => `تم دفع ${p.amount}${p.zar} لم تعد أي قاعدة بحاجة إليها ${p.to} في ${p.date}.`,
      sale: (p) => `${{ car: "تم بيع السيارة", motorbike: "تم بيع الدراجة النارية", asset: "تم بيع الأصل" }[p.asset]} مقابل ${p.amount}${p.zar} في ${p.date}، وتم دفع المال ${p.to}.`,
    },
  },
  sw: {
    translated: "machine", intl: "sw",
    about: (z) => ` (takriban ${z})`,
    to: (n) => `kwa ${n}`,
    roles: { payee: "kwa mpokeaji aliyeidhinishwa", landlord: "kwa mwenye nyumba aliyeidhinishwa", ownWallet: "kwenye pochi ya mwanafamilia", family: "kwa mwanafamilia", recipient: "kwa mpokeaji aliyetajwa", vault: "kwenye hazina ya mirathi" },
    purpose: { Tuition: "ada za masomo", Accommodation: "malazi", Books: "vitabu", Medical: "matibabu", General: "matumizi ya kila siku" },
    forWhat: (p, who) => (who ? `kwa ajili ya ${p} (${who})` : `kwa ajili ya ${p}`),
    sentence: {
      claim: (p) => `${p.amount}${p.zar} zililipwa ${p.to} ${p.for} tarehe ${p.date}.`,
      scheduled: (p) => `Malipo yaliyopangwa ya ${p.amount}${p.zar} yalilipwa ${p.to} ${p.for} tarehe ${p.date}.`,
      fallback: (p) => `Kwa mpango wa dharura, hazina yote, ${p.amount}${p.zar}, ililipwa ${p.to} tarehe ${p.date}.`,
      sweep: (p) => `${p.amount}${p.zar} ambazo hakuna kanuni iliyozihitaji tena zililipwa ${p.to} tarehe ${p.date}.`,
      sale: (p) => `${{ car: "Gari", motorbike: "Pikipiki", asset: "Mali" }[p.asset]} iliuzwa kwa ${p.amount}${p.zar} tarehe ${p.date}, na pesa zililipwa ${p.to}.`,
    },
  },
  hi: {
    translated: "machine", intl: "hi",
    about: (z) => ` (लगभग ${z})`,
    to: (n) => `${n} को`,
    roles: { payee: "एक स्वीकृत प्राप्तकर्ता को", landlord: "एक स्वीकृत मकान-मालिक को", ownWallet: "परिवार के एक सदस्य के अपने वॉलेट में", family: "परिवार के एक सदस्य को", recipient: "नामित प्राप्तकर्ता को", vault: "संपत्ति की तिजोरी में" },
    purpose: { Tuition: "पढ़ाई की फ़ीस", Accommodation: "रहने के ख़र्च", Books: "किताबों", Medical: "इलाज", General: "रोज़मर्रा के ख़र्च" },
    forWhat: (p, who) => (who ? `${who} की ${p} के लिए` : `${p} के लिए`),
    sentence: {
      claim: (p) => `${p.date} को ${p.to} ${p.for} ${p.amount}${p.zar} का भुगतान किया गया।`,
      scheduled: (p) => `${p.date} को ${p.to} ${p.for} ${p.amount}${p.zar} का निर्धारित भुगतान किया गया।`,
      fallback: (p) => `बैकअप योजना के तहत, ${p.date} को पूरी तिजोरी, ${p.amount}${p.zar}, ${p.to} दी गई।`,
      sweep: (p) => `${p.date} को ${p.amount}${p.zar}, जिसकी अब किसी नियम को ज़रूरत नहीं थी, ${p.to} दिए गए।`,
      sale: (p) => `${p.date} को ${{ car: "कार", motorbike: "मोटरसाइकिल", asset: "संपत्ति" }[p.asset]} ${p.amount}${p.zar} में बेची गई, और पैसा ${p.to} दिया गया।`,
    },
  },
  zh: {
    translated: "machine", intl: "zh",
    about: (z) => `（约${z}）`,
    to: (n) => `向${n}`,
    roles: { payee: "向一位已批准的收款方", landlord: "向一位已批准的房东", ownWallet: "向一位家庭成员的个人钱包", family: "向一位家庭成员", recipient: "向指定的接收人", vault: "向遗产金库" },
    purpose: { Tuition: "学费", Accommodation: "住宿费", Books: "书费", Medical: "医疗费", General: "日常开支" },
    forWhat: (p, who) => (who ? `用于${who}的${p}` : `用于${p}`),
    sentence: {
      claim: (p) => `${p.date}，已${p.to}支付${p.amount}${p.zar}，${p.for}。`,
      scheduled: (p) => `${p.date}，已按计划${p.to}支付${p.amount}${p.zar}，${p.for}。`,
      fallback: (p) => `${p.date}，根据备用计划，整个金库共${p.amount}${p.zar}已${p.to}支付。`,
      sweep: (p) => `${p.date}，已${p.to}支付${p.amount}${p.zar}，这笔钱已不再被任何规则需要。`,
      sale: (p) => `${p.date}，${{ car: "汽车", motorbike: "摩托车", asset: "资产" }[p.asset]}以${p.amount}${p.zar}售出，款项已${p.to}支付。`,
    },
  },
};

/** How each language's receipt was translated (machine translations await a first-language read, plan §20.2). */
export const RECEIPT_TRANSLATION: Record<VoiceLanguage, "human" | "machine"> =
  Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.translated])) as Record<VoiceLanguage, "human" | "machine">;

const supported = (tag: string) => { try { return Intl.NumberFormat.supportedLocalesOf(tag).length > 0 ? tag : "en-ZA"; } catch { return "en-ZA"; } };

/** "1 500" (display) or "1500" (speech: some voices read a grouping space as a pause between two numbers). */
function number(n: number, intl: string, spoken: boolean, fraction: number): string {
  return new Intl.NumberFormat(supported(intl), { minimumFractionDigits: fraction, maximumFractionDigits: fraction, useGrouping: !spoken }).format(n);
}

function usdt(base: bigint, intl: string, spoken: boolean): string {
  const whole = base % 1_000_000n === 0n;
  const n = Number(base) / 1_000_000;
  return `${number(n, intl, spoken, whole ? 0 : 2)} ${spoken ? "USDT" : "USD₮"}`;
}

/** Rand, rounded (to R10 from R1 000): "R26 800" shown, "26800 South African rand" spoken. */
function rand(base: bigint, rate: number, lang: LanguageTemplates, spoken: boolean): string {
  const raw = (Number(base) / 1_000_000) * rate;
  const n = raw >= 1000 ? Math.round(raw / 10) * 10 : Math.round(raw);
  if (!spoken && lang.randSign) return `R${number(n, lang.intl, false, 0)}`;
  try {
    return new Intl.NumberFormat(supported(lang.intl), { style: "currency", currency: "ZAR", currencyDisplay: "name", maximumFractionDigits: 0, minimumFractionDigits: 0, useGrouping: !spoken }).format(n);
  } catch {
    return `R${number(n, "en-ZA", spoken, 0)}`;
  }
}

/** "24 November" (the year too when it is not this year), in Johannesburg time like the statement. */
function date(ts: number, intl: string, nowSecs: number): string {
  const tz = STATEMENT_TZ;
  const year = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(new Date(t * 1000));
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz, day: "numeric", month: "long", ...(year(ts) !== year(nowSecs) ? { year: "numeric" } : {}) };
  return new Intl.DateTimeFormat(supported(intl), opts).format(new Date(ts * 1000));
}

export interface ReceiptWords {
  lang: VoiceLanguage;
  /** What the screen shows. */
  text: string;
  /** What the voice reads (the same sentence, numbers ungrouped, "USDT", rand by name). */
  speech: string;
  /** False where ElevenLabs can't speak the language: the words are shown, never read by the browser. */
  spoken: boolean;
  translated: "human" | "machine";
}

/** The receipt's sentence in `lang`, from the facts only. `nowSecs` decides whether the date says the year. */
export function receiptWords(facts: ReceiptFacts, lang: VoiceLanguage, nowSecs = Math.floor(Date.now() / 1000)): ReceiptWords {
  const L = T[lang];
  const build = (spoken: boolean) => {
    const rate = facts.usdtZar && Number.isFinite(facts.usdtZar) && facts.usdtZar > 0 ? facts.usdtZar : null;
    const parts: Parts = {
      amount: usdt(facts.amount, L.intl, spoken),
      zar: rate ? L.about(rand(facts.amount, rate, L, spoken)) : "",
      to: "name" in facts.to ? L.to(facts.to.name) : L.roles[facts.to.role],
      for: facts.purpose ? L.forWhat(L.purpose[facts.purpose], facts.person) : "",
      date: date(facts.ts, L.intl, nowSecs),
      asset: facts.asset ?? "asset",
    };
    return L.sentence[facts.kind](parts).replace(/ {2,}/g, " ").replace(/ ([.,،。])/g, "$1");
  };
  return { lang, text: build(false), speech: build(true), spoken: VOICE_LANGUAGES[lang].support.speech, translated: L.translated };
}

/* ----- the demo's fixed data (mock mode) ----- */

/** Children in the demo story, by key. Their persona wallets are fixed (lib/wallet/personas.ts). */
export const DEMO_RECEIPT_PEOPLE = {
  lerato: { name: "Lerato", wallet: DEMO_PERSONAS[1].address },
  sipho: { name: "Sipho", wallet: DEMO_PERSONAS[2].address },
  naledi: { name: "Naledi", wallet: DEMO_PERSONAS[3].address },
} as const;
type PersonKey = keyof typeof DEMO_RECEIPT_PEOPLE;
const PERSON_KEYS = Object.keys(DEMO_RECEIPT_PEOPLE) as PersonKey[];

/** The charity at the end of the demo's fallback order (same as DEMO_GUARDIANS.charity in lib/service/mock.ts). */
export const DEMO_RECEIPT_CHARITY = { name: "Ithemba Children's Charity", wallet: "6gUaiCvYvtSfEY2y4ygyVSwTjnV4oNP5ENoCdweqPVsN" } as const;

/** The demo's approved payees by key: p0 … p4 (lib/service/mock-payees.ts). */
export const DEMO_RECEIPT_PAYEES: Record<string, { name: string; wallet: string }> =
  Object.fromEntries(DEMO_PAYEES.map((p, i) => [`p${i}`, { name: p.name, wallet: p.wallet }]));

const CATEGORIES: readonly Category[] = ["Tuition", "Accommodation", "Books", "Medical", "General"];
const ASSETS: readonly ReceiptAsset[] = ["car", "motorbike", "asset"];
const KINDS: readonly ReceiptKind[] = ["claim", "scheduled", "fallback", "sweep", "sale"];

/** Most a demo receipt may say: 10 million USD₮. */
const MAX_DEMO_AMOUNT = 10_000_000n * 1_000_000n;
/** The demo story runs from 2020 (history) to 2100 (the imagined future). */
const DEMO_TS = { min: Date.UTC(2020, 0, 1) / 1000, max: Date.UTC(2100, 0, 1) / 1000 };

/** demo.<kind>.<to>.<what>.<person>.<amount base units>.<unix seconds>: only keys, digits and dashes. */
export const DEMO_RECEIPT_ID = /^demo\.[a-z]{4,9}\.[a-z0-9-]{2,12}\.[A-Za-z-]{1,13}\.[a-z-]{1,6}\.[1-9]\d{0,15}\.\d{10}$/;

/** The demo receipt's facts, or null when any part is not in the demo's fixed tables. `usdtZar` is the server's. */
export function parseDemoReceiptId(id: string, usdtZar: number | null): ReceiptFacts | null {
  if (!DEMO_RECEIPT_ID.test(id)) return null;
  const [, kind, to, what, person, amountStr, tsStr] = id.split(".");
  if (!(KINDS as readonly string[]).includes(kind)) return null;
  const amount = BigInt(amountStr);
  const ts = Number(tsStr);
  if (amount <= 0n || amount > MAX_DEMO_AMOUNT || ts < DEMO_TS.min || ts > DEMO_TS.max) return null;
  const k = kind as ReceiptKind;
  const isPerson = (s: string): s is PersonKey => (PERSON_KEYS as string[]).includes(s);
  if (k === "claim" || k === "scheduled") {
    if (!(CATEGORIES as readonly string[]).includes(what)) return null;
    if (person !== "-" && !isPerson(person)) return null;
    let party: ReceiptParty;
    if (DEMO_RECEIPT_PAYEES[to]) party = { name: DEMO_RECEIPT_PAYEES[to].name };
    else if (to.startsWith("own-") && isPerson(to.slice(4))) party = { role: "ownWallet" };
    else return null;
    return { kind: k, amount, ts, to: party, purpose: what as Category, ...(isPerson(person) ? { person: DEMO_RECEIPT_PEOPLE[person].name } : {}), usdtZar };
  }
  if (person !== "-") return null;
  if (k === "fallback" || k === "sweep") {
    if (what !== "-") return null;
    const party = isPerson(to) ? { name: DEMO_RECEIPT_PEOPLE[to].name } : to === "charity" ? { name: DEMO_RECEIPT_CHARITY.name } : null;
    return party ? { kind: k, amount, ts, to: party, usdtZar } : null;
  }
  if (!(ASSETS as readonly string[]).includes(what)) return null;
  const party: ReceiptParty | null = to === "vault" ? { role: "vault" } : isPerson(to) ? { name: DEMO_RECEIPT_PEOPLE[to].name } : null;
  return party ? { kind: k, amount, ts, to: party, asset: what as ReceiptAsset, usdtZar } : null;
}

/** What the demo's receipt id is built from: the activity line and the parts of the demo estate it names. */
export interface DemoReceiptSource {
  item: ActivityItem;
  /** The estate's address (a sale into the vault), rules (category and person) and assets (what was sold). */
  estate?: Base58;
  rules?: readonly { address: Base58; beneficiary: Base58; category: Category }[];
  assets?: readonly { address: Base58; title: string }[];
}

const personKeyOf = (wallet: Base58 | undefined | null): PersonKey | null =>
  PERSON_KEYS.find((k) => DEMO_RECEIPT_PEOPLE[k].wallet === wallet) ?? null;

/** The demo receipt id for a payout line (browser side), or null when the line is not one of the demo's payments. */
export function demoReceiptId({ item, estate, rules, assets }: DemoReceiptSource): string | null {
  const kind = receiptKindOf(item.kind);
  if (!kind || typeof item.amount !== "bigint" || item.amount <= 0n || !Number.isFinite(item.ts)) return null;
  const tail = `${item.amount}.${Math.floor(item.ts)}`;
  if (kind === "claim" || kind === "scheduled") {
    const pay = item.payment;
    if (!pay) return null;
    const rule = pay.rule ? rules?.find((r) => r.address === pay.rule) : undefined;
    if (!rule) return null;
    const payeeKey = Object.keys(DEMO_RECEIPT_PAYEES).find((k) => DEMO_RECEIPT_PAYEES[k].wallet === pay.payee);
    const own = personKeyOf(pay.payee);
    const to = payeeKey ?? (own ? `own-${own}` : null);
    if (!to) return null;
    return `demo.${kind}.${to}.${rule.category}.${personKeyOf(rule.beneficiary) ?? "-"}.${tail}`;
  }
  if (kind === "fallback" || kind === "sweep") {
    const w = item.payment?.payee;
    const to = personKeyOf(w) ?? (w === DEMO_RECEIPT_CHARITY.wallet ? "charity" : null);
    return to ? `demo.${kind}.${to}.-.-.${tail}` : null;
  }
  const sale = item.sale;
  if (!sale) return null;
  const to = sale.recipient === estate ? "vault" : personKeyOf(sale.recipient);
  if (!to) return null;
  const title = assets?.find((a) => a.address === sale.asset)?.title ?? "";
  const what: ReceiptAsset = /corolla|car|motor vehicle/i.test(title) && !/motorbike|motorcycle|mustang/i.test(title) ? "car" : /motorbike|motorcycle|mustang|bike/i.test(title) ? "motorbike" : "asset";
  return `demo.sale.${to}.${what}.-.${tail}`;
}
