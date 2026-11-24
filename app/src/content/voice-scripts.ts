/**
 * What the voice agent SAYS, per spoken language (plan §20.1), added 24 Nov 2026:
 * - firstMessage: the agent's greeting, sent as the ElevenLabs `firstMessage` override when the call is not in English
 *   (English uses the greeting configured on the agent, scripts/elevenlabs-agent.ts). {name} is the caller's first name.
 * - preview: the simulated call on the demo site (lib/hooks/mock-voice.ts), so visitors without a key hear the idea.
 * Every language the agent can speak (languagesFor("agent") in lib/voice/languages.ts) needs an entry
 * (content/voice.test.ts). Loaded only when a call starts.
 *
 * TRANSLATIONS: every non-English entry below is MACHINE TRANSLATED (24 Nov 2026) and marked `translated: "machine"`;
 * the call screen says so. Names, "Heirloom" and amounts stay as they are. Review by a first-language speaker.
 */
import { assistant } from "./assistant";
import type { VoiceLanguage } from "../lib/voice/languages";

export interface PreviewLine { role: "user" | "agent"; specialist?: string; text: string }

export interface SpokenScript {
  /** Present when a machine wrote the words; the UI shows a small note. */
  translated?: "machine";
  firstMessage: { named: string; guest: string };
  preview: readonly PreviewLine[];
}

const ES = "EstateGuide", CO = "Compliance", CG = "ClaimsGuide";

export const voiceScripts: Partial<Record<VoiceLanguage, SpokenScript>> = {
  en: {
    firstMessage: {
      named: "Hi {name}, I'm Heirloom's assistant. I can help with the will, a claim, the car sale, or what happens next with the estate. How can I help?",
      guest: "Hi there, I'm Heirloom's assistant. I can help with the will, a claim, the car sale, or what happens next with the estate. How can I help?",
    },
    preview: assistant.voicePreview,
  },
  af: {
    translated: "machine",
    firstMessage: {
      named: "Hallo {name}, ek is Heirloom se assistent. Ek kan help met die testament, 'n eis, die verkoop van die motor, of wat volgende met die boedel gebeur. Hoe kan ek help?",
      guest: "Hallo, ek is Heirloom se assistent. Ek kan help met die testament, 'n eis, die verkoop van die motor, of wat volgende met die boedel gebeur. Hoe kan ek help?",
    },
    preview: [
      { role: "agent", specialist: ES, text: "Hallo, dis Heirloom. Ek kan die boedel op jou skerm sien. Wat wil jy weet?" },
      { role: "user", text: "Kan enigiemand geld uit die kluis haal sodra dit oopgesluit is?" },
      { role: "agent", specialist: CO, text: "Net soos die plan toelaat. Reëls betaal goedgekeurde begunstigdes binne hul perke. Wat oorbly, die terugvalgeld en die verkoopgeld gaan net waarheen die eienaar bepaal het. Ek kan dit nie verander nie." },
      { role: "user", text: "En hoe word skoolgeld betaal?" },
      { role: "agent", specialist: CG, text: "Laai die staat van die gelde op. Ek lees dit, 'n vertroude persoon keur dit gewoonlik goed, en dan kan die kluis die universiteit direk betaal. Ek kan nou die eisvorm vir jou oopmaak." },
    ],
  },
  fr: {
    translated: "machine",
    firstMessage: {
      named: "Bonjour {name}, je suis l'assistant de Heirloom. Je peux vous aider pour le testament, une demande de paiement, la vente de la voiture ou la suite de la succession. Comment puis-je vous aider ?",
      guest: "Bonjour, je suis l'assistant de Heirloom. Je peux vous aider pour le testament, une demande de paiement, la vente de la voiture ou la suite de la succession. Comment puis-je vous aider ?",
    },
    preview: [
      { role: "agent", specialist: ES, text: "Bonjour, ici Heirloom. Je vois la succession sur votre écran. Que voulez-vous savoir ?" },
      { role: "user", text: "Est-ce que n'importe qui peut retirer de l'argent du coffre une fois qu'il est débloqué ?" },
      { role: "agent", specialist: CO, text: "Seulement comme le plan le permet. Les règles paient des bénéficiaires approuvés, dans leurs limites. Le reste, la solution de repli et l'argent de la vente vont uniquement là où le propriétaire l'a décidé. Je ne peux pas changer cela." },
      { role: "user", text: "Et comment les frais de scolarité sont-ils payés ?" },
      { role: "agent", specialist: CG, text: "Envoyez le relevé des frais. Je le lis, une personne de confiance l'approuve en général, puis le coffre peut payer l'université directement. Je peux ouvrir le formulaire de demande pour vous maintenant." },
    ],
  },
  pt: {
    translated: "machine",
    firstMessage: {
      named: "Olá {name}, sou o assistente da Heirloom. Posso ajudar com o testamento, um pedido de pagamento, a venda do carro ou o que acontece a seguir com o património. Como posso ajudar?",
      guest: "Olá, sou o assistente da Heirloom. Posso ajudar com o testamento, um pedido de pagamento, a venda do carro ou o que acontece a seguir com o património. Como posso ajudar?",
    },
    preview: [
      { role: "agent", specialist: ES, text: "Olá, aqui é a Heirloom. Vejo o património no seu ecrã. O que gostaria de saber?" },
      { role: "user", text: "Qualquer pessoa pode tirar dinheiro do cofre depois de ser desbloqueado?" },
      { role: "agent", specialist: CO, text: "Só como o plano permite. As regras pagam beneficiários aprovados, dentro dos seus limites. O que sobra, o plano alternativo e o dinheiro da venda vão apenas para onde o dono definiu. Eu não posso mudar isso." },
      { role: "user", text: "E como são pagas as propinas escolares?" },
      { role: "agent", specialist: CG, text: "Carregue o extrato das propinas. Eu leio-o, normalmente uma pessoa de confiança aprova, e depois o cofre pode pagar diretamente à universidade. Posso abrir já o formulário do pedido." },
    ],
  },
  es: {
    translated: "machine",
    firstMessage: {
      named: "Hola {name}, soy el asistente de Heirloom. Puedo ayudarle con el testamento, una solicitud de pago, la venta del coche o lo que sigue con la herencia. ¿En qué puedo ayudarle?",
      guest: "Hola, soy el asistente de Heirloom. Puedo ayudarle con el testamento, una solicitud de pago, la venta del coche o lo que sigue con la herencia. ¿En qué puedo ayudarle?",
    },
    preview: [
      { role: "agent", specialist: ES, text: "Hola, soy Heirloom. Veo la herencia en su pantalla. ¿Qué le gustaría saber?" },
      { role: "user", text: "¿Cualquiera puede sacar dinero de la bóveda una vez desbloqueada?" },
      { role: "agent", specialist: CO, text: "Solo como lo permite el plan. Las reglas pagan a beneficiarios aprobados, dentro de sus límites. Lo que sobra, el plan de respaldo y el dinero de la venta van solo adonde decidió el propietario. Yo no puedo cambiar eso." },
      { role: "user", text: "¿Y cómo se pagan las cuotas escolares?" },
      { role: "agent", specialist: CG, text: "Suba el estado de cuenta de las cuotas. Lo leo, normalmente una persona de confianza lo aprueba y luego la bóveda puede pagar directamente a la universidad. Puedo abrirle ahora el formulario de solicitud." },
    ],
  },
  ar: {
    translated: "machine",
    firstMessage: {
      named: "مرحبًا {name}، أنا مساعد Heirloom. يمكنني مساعدتك في الوصية أو طلب صرف أو بيع السيارة أو ما سيحدث بعد ذلك في التركة. كيف يمكنني مساعدتك؟",
      guest: "مرحبًا، أنا مساعد Heirloom. يمكنني مساعدتك في الوصية أو طلب صرف أو بيع السيارة أو ما سيحدث بعد ذلك في التركة. كيف يمكنني مساعدتك؟",
    },
    preview: [
      { role: "agent", specialist: ES, text: "مرحبًا، معك Heirloom. أرى التركة على شاشتك. ماذا تريد أن تعرف؟" },
      { role: "user", text: "هل يستطيع أي شخص سحب المال من الخزنة بعد فتحها؟" },
      { role: "agent", specialist: CO, text: "فقط كما تسمح الخطة. القواعد تدفع للمستفيدين المعتمدين ضمن حدودهم. ما يتبقى، والخطة البديلة، وأموال البيع تذهب فقط إلى حيث حدّد المالك. لا أستطيع تغيير ذلك." },
      { role: "user", text: "وكيف تُدفع الرسوم المدرسية؟" },
      { role: "agent", specialist: CG, text: "ارفع كشف الرسوم. أقرأه، وعادةً يوافق عليه شخص موثوق، ثم تستطيع الخزنة الدفع للجامعة مباشرة. يمكنني فتح نموذج الطلب لك الآن." },
    ],
  },
  sw: {
    translated: "machine",
    firstMessage: {
      named: "Habari {name}, mimi ni msaidizi wa Heirloom. Ninaweza kukusaidia kuhusu wosia, ombi la malipo, uuzaji wa gari, au kinachofuata kuhusu mirathi. Nikusaidie vipi?",
      guest: "Habari, mimi ni msaidizi wa Heirloom. Ninaweza kukusaidia kuhusu wosia, ombi la malipo, uuzaji wa gari, au kinachofuata kuhusu mirathi. Nikusaidie vipi?",
    },
    preview: [
      { role: "agent", specialist: ES, text: "Habari, huyu ni Heirloom. Naona mirathi kwenye skrini yako. Ungependa kujua nini?" },
      { role: "user", text: "Je, mtu yeyote anaweza kutoa pesa kwenye hazina baada ya kufunguliwa?" },
      { role: "agent", specialist: CO, text: "Kama mpango unavyoruhusu tu. Sheria hulipa walengwa walioidhinishwa ndani ya mipaka yao. Kinachobaki, mpango mbadala na pesa za mauzo huenda tu pale mmiliki alipoamua. Siwezi kubadilisha hilo." },
      { role: "user", text: "Na ada za shule hulipwaje?" },
      { role: "agent", specialist: CG, text: "Pakia taarifa ya ada. Ninaisoma, kwa kawaida mtu unayemwamini anaidhinisha, kisha hazina inaweza kulipa chuo kikuu moja kwa moja. Ninaweza kukufungulia fomu ya madai sasa." },
    ],
  },
  hi: {
    translated: "machine",
    firstMessage: {
      named: "नमस्ते {name}, मैं Heirloom का सहायक हूँ। मैं वसीयत, किसी भुगतान दावे, कार की बिक्री, या संपत्ति के आगे के कदमों में मदद कर सकता हूँ। मैं आपकी कैसे मदद करूँ?",
      guest: "नमस्ते, मैं Heirloom का सहायक हूँ। मैं वसीयत, किसी भुगतान दावे, कार की बिक्री, या संपत्ति के आगे के कदमों में मदद कर सकता हूँ। मैं आपकी कैसे मदद करूँ?",
    },
    preview: [
      { role: "agent", specialist: ES, text: "नमस्ते, मैं Heirloom हूँ। मुझे आपकी स्क्रीन पर संपत्ति दिख रही है। आप क्या जानना चाहेंगे?" },
      { role: "user", text: "क्या तिजोरी खुलने के बाद कोई भी उसमें से पैसे निकाल सकता है?" },
      { role: "agent", specialist: CO, text: "सिर्फ़ उतना, जितना योजना अनुमति देती है। नियम स्वीकृत प्राप्तकर्ताओं को उनकी सीमा के भीतर भुगतान करते हैं। बचा हुआ पैसा, वैकल्पिक योजना और बिक्री का पैसा सिर्फ़ वहीं जाता है जहाँ मालिक ने तय किया है। मैं इसे नहीं बदल सकता।" },
      { role: "user", text: "और स्कूल की फ़ीस कैसे भरी जाती है?" },
      { role: "agent", specialist: CG, text: "फ़ीस का विवरण अपलोड कीजिए। मैं उसे पढ़ता हूँ, आमतौर पर कोई भरोसेमंद व्यक्ति मंज़ूरी देता है, और फिर तिजोरी सीधे विश्वविद्यालय को भुगतान कर सकती है। मैं अभी आपके लिए दावा फ़ॉर्म खोल सकता हूँ।" },
    ],
  },
  zh: {
    translated: "machine",
    firstMessage: {
      named: "{name}，您好，我是 Heirloom 的助手。我可以帮您处理遗嘱、付款申请、卖车，或者遗产接下来的安排。有什么可以帮您？",
      guest: "您好，我是 Heirloom 的助手。我可以帮您处理遗嘱、付款申请、卖车，或者遗产接下来的安排。有什么可以帮您？",
    },
    preview: [
      { role: "agent", specialist: ES, text: "您好，这里是 Heirloom。我能看到您屏幕上的遗产。您想了解什么？" },
      { role: "user", text: "金库解锁后，任何人都能从里面取钱吗？" },
      { role: "agent", specialist: CO, text: "只能按计划允许的方式。规则只在限额内向已批准的收款方付款。剩余的钱、备用安排和出售所得只会去往所有者指定的地方。我无法改变这些。" },
      { role: "user", text: "那学费怎么支付？" },
      { role: "agent", specialist: CG, text: "上传学费账单。我会阅读它，通常由一位受信任的人批准，然后金库可以直接付款给大学。我现在就可以为您打开申请表。" },
    ],
  },
};

/** The script for `lang`, or English when there is none (never for a language the agent can speak; see the test). */
export function scriptFor(lang: VoiceLanguage): SpokenScript & { lang: VoiceLanguage } {
  const s = voiceScripts[lang];
  return s ? { ...s, lang } : { ...(voiceScripts.en as SpokenScript), lang: "en" };
}

/** The greeting with the caller's first name, or the no-name form for a guest. */
export function firstMessageFor(lang: VoiceLanguage, name?: string): string {
  const f = scriptFor(lang).firstMessage;
  return name ? f.named.replace("{name}", name) : f.guest;
}
