/**
 * Voice typing (content/listen.ts) in Afrikaans, Sesotho and isiZulu. Machine-assisted translation, like the rest of
 * af/st/zu: review by a first-language speaker before production. Every key is required.
 * "ElevenLabs" is a company name and stays as it is.
 */
import type { ListenCopy } from "../listen";
import type { Widen } from "@/lib/i18n/merge";

type T = Widen<ListenCopy>;

export const listenAf: T = {
  start: "Praat eerder as om te tik ({language})",
  stop: "Stop en maak my woorde teks",
  checking: "Stemtik word gereed gemaak…",
  listening: "Luister in {language}. Tik weer op die mikrofoon as jy klaar is (tot 'n minuut).",
  transcribing: "Jou woorde word teks…",
  done: "Jou woorde is in die blokkie. Gaan dit na, en stuur dan.",
  notice: "Jou opname word na ElevenLabs gestuur om dit in teks om te sit, en word nie gehou nie.",
  privacyLink: "Privaatheid",
  unavailable: "Stemtik het die regstreekse diens nodig, wat nie hier aangeskakel is nie. Tik asseblief eerder.",
  errors: {
    blocked: "Die mikrofoon is geblokkeer. Laat dit toe in jou blaaier se instellings, of tik eerder.",
    unsupported: "Hierdie blaaier kan nie hier opneem nie. Tik asseblief eerder.",
    empty: "Ons het geen woorde gehoor nie. Probeer weer 'n bietjie nader aan die mikrofoon.",
    busy: "Stemtik is nou besig. Wag asseblief 'n minuut, of tik eerder.",
    failed: "Stemtik het nie hierdie keer gewerk nie. Probeer asseblief weer, of tik eerder.",
  },
};

export const listenSt: T = {
  start: "Bua ho e na le ho thaepa ({language})",
  stop: "Emisa mme o fetole mantswe a ka e be mongolo",
  checking: "Ho lokisa ho thaepa ka lentswe…",
  listening: "Ke mametse ({language}). Tobetsa maekrofounu hape ha o qetile (ho fihlela motsotso o le mong).",
  transcribing: "Mantswe a hao a fetolwa mongolo…",
  done: "Mantswe a hao a ka lebokoseng. A hlahlobe, ebe o a romela.",
  notice: "Rekoto ya hao e romelwa ho ElevenLabs ho e fetola mongolo, mme ha e bolokwe.",
  privacyLink: "Lekunutu",
  unavailable: "Ho thaepa ka lentswe ho hloka tshebeletso e phelang, e sa bulelwang mona. Ka kopo thaepa.",
  errors: {
    blocked: "Maekrofounu e thibetswe. E dumelle ditlhophisong tsa sebadi sa hao, kapa o thaepe.",
    unsupported: "Sebadi sena se ke ke sa rekota mona. Ka kopo thaepa.",
    empty: "Ha re a utlwa mantswe. Leka hape o le haufi le maekrofounu.",
    busy: "Ho thaepa ka lentswe ho phathahane hona jwale. Ka kopo ema motsotso, kapa o thaepe.",
    failed: "Ho thaepa ka lentswe ha ho a sebetsa lekgetlong lena. Ka kopo leka hape, kapa o thaepe.",
  },
};

export const listenZu: T = {
  start: "Khuluma esikhundleni sokuthayipha ({language})",
  stop: "Misa bese uguqula amagama ami abe umbhalo",
  checking: "Kulungiswa ukuthayipha ngezwi…",
  listening: "Ngilalele ({language}). Thepha imakrofoni futhi uma usuqedile (kuze kube umzuzu owodwa).",
  transcribing: "Amagama akho aguqulwa abe umbhalo…",
  done: "Amagama akho asebhokisini. Wahlole, bese uyathumela.",
  notice: "Okuqoshiwe kwakho kuthunyelwa ku-ElevenLabs ukuze kuguqulwe kube umbhalo, futhi akugcinwa.",
  privacyLink: "Ubumfihlo",
  unavailable: "Ukuthayipha ngezwi kudinga isevisi ebukhoma, engavuliwe lapha. Sicela uthayiphe.",
  errors: {
    blocked: "Imakrofoni ivinjiwe. Yivumele kuzilungiselelo zesiphequluli sakho, noma uthayiphe.",
    unsupported: "Lesi siphequluli asikwazi ukuqopha lapha. Sicela uthayiphe.",
    empty: "Asizwanga magama. Zama futhi useduze nemakrofoni.",
    busy: "Ukuthayipha ngezwi kumatasa manje. Sicela ulinde umzuzu, noma uthayiphe.",
    failed: "Ukuthayipha ngezwi akusebenzanga kulokhu. Sicela uzame futhi, noma uthayiphe.",
  },
};
