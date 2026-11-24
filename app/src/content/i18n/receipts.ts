/**
 * Spoken receipts copy (content/receipts.ts) in Afrikaans, Sesotho and isiZulu.
 * Machine-assisted translation: review by a first-language speaker before production.
 */
import type { ReceiptsCopy } from "../receipts";

export const receiptsAf: ReceiptsCopy = {
  hear: "Luister",
  hearSr: "Luister hoe hierdie betaling se kwitansie voorgelees word",
  stop: "Stop",
  stopSr: "Stop die kwitansie",
  loading: "Kry die kwitansie…",
  playing: "Die kwitansie speel.",
  done: "Kwitansie klaar gespeel.",
  voice: "Voorgelees deur Heirloom se ElevenLabs-stem.",
  textOnly: "Die stem is nou nie beskikbaar nie, so hier is die kwitansie om te lees:",
  notSpoken: "Kwitansies kan nog nie in hierdie taal gepraat word nie, so hier is die kwitansie om te lees:",
  machine: "Masjienvertaal",
  failed: "Die kwitansie kon nie gekry word nie. Probeer weer oor 'n oomblik.",
  limited: "Te veel kwitansies op een slag. Wag 'n minuut en probeer weer.",
  notFound: "Hierdie betaling kon nog nie op die netwerk gevind word nie. Probeer weer oor 'n oomblik.",
};

export const receiptsSt: ReceiptsCopy = {
  hear: "Mamela",
  hearSr: "Mamela rasiti ya tefo ena e balwa ka lentswe",
  stop: "Emisa",
  stopSr: "Emisa rasiti",
  loading: "Ho lata rasiti…",
  playing: "Rasiti e a bapala.",
  done: "Rasiti e qetile ho bapala.",
  voice: "E balwa ke lentswe la ElevenLabs la Heirloom.",
  textOnly: "Lentswe ha le fumanehe hona jwale, ka hona rasiti ke ena hore o e bale:",
  notSpoken: "Direseiti di ntse di sa kgone ho buuwa ka puo ena, ka hona rasiti ke ena hore o e bale:",
  machine: "E fetoletswe ke motjhini",
  failed: "Rasiti ha e a ka ya fumaneha. Leka hape kamora motsotswana.",
  limited: "Direseiti di ngata haholo ka nako e le nngwe. Ema motsotso o le mong ebe o leka hape.",
  notFound: "Tefo ena ha e so fumanehe marangrangeng. Leka hape kamora motsotswana.",
};

export const receiptsZu: ReceiptsCopy = {
  hear: "Lalela",
  hearSr: "Lalela irisidi yale nkokhelo ifundwa ngezwi",
  stop: "Misa",
  stopSr: "Misa irisidi",
  loading: "Ilanda irisidi…",
  playing: "Irisidi iyadlala.",
  done: "Irisidi iqedile ukudlala.",
  voice: "Ifundwa yizwi le-ElevenLabs le-Heirloom.",
  textOnly: "Izwi alitholakali okwamanje, ngakho nansi irisidi ukuze uyifunde:",
  notSpoken: "Amarisidi awakwazi ukukhulunywa ngalolu limi okwamanje, ngakho nansi irisidi ukuze uyifunde:",
  machine: "Kuhunyushwe ngomshini",
  failed: "Irisidi ayitholakalanga. Zama futhi emva kwesikhashana.",
  limited: "Amarisidi amaningi kakhulu ngesikhathi esisodwa. Linda umzuzu bese uzama futhi.",
  notFound: "Le nkokhelo ayikatholakali kunethiwekhi. Zama futhi emva kwesikhashana.",
};
