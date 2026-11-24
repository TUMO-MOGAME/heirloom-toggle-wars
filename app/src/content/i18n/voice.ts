/**
 * The spoken-language choice (content/voice.ts) in Afrikaans, Sesotho and isiZulu.
 * Machine-assisted translation: review by a first-language speaker before production.
 */
import type { VoiceCopy } from "../voice";
import type { Widen } from "@/lib/i18n/merge";

type T = Widen<VoiceCopy>;

export const voiceAf: T = {
  picker: {
    label: "Gesproke taal",
    hint: "Heirloom praat en luister in hierdie taal tydens die oproep. Die skerms bly in hul eie taal.",
    same: "Dieselfde as die app ({name})",
    fallback: "Oproepe in {ui} is nog nie beskikbaar nie, so Heirloom sal {lang} praat.",
  },
  machine: "Masjienvertaal: wag op 'n moedertaalspreker om dit na te gaan.",
};

export const voiceSt: T = {
  picker: {
    label: "Puo e buuwang",
    hint: "Heirloom e bua le ho mamela ka puo ena mohalang. Dikgaolo di dula ka puo ya tsona.",
    same: "E tshwanang le ya app ({name})",
    fallback: "Mehala ka {ui} ha e so fumanehe, kahoo Heirloom e tla bua {lang}.",
  },
  machine: "E fetoletswe ka mochine: e emetse ho balwa ke sebui sa puo ena.",
};

export const voiceZu: T = {
  picker: {
    label: "Ulimi olukhulunywayo",
    hint: "I-Heirloom ikhuluma futhi ilalele ngalolu limi ocingweni. Izikrini zihlala olimini lwazo.",
    same: "Kufana ne-app ({name})",
    fallback: "Izingcingo nge-{ui} azikatholakali okwamanje, ngakho i-Heirloom izokhuluma i-{lang}.",
  },
  machine: "Kuhunyushwe ngomshini: kulindelwe ukufundwa yisikhulumi solimi lwebele.",
};
