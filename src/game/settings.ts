// Impostazioni del giocatore. Con il ponte stanno in SQLite (vedi src/server/store.ts) e valgono per tutti i progetti;
// localStorage ne tiene una copia, usata nella demo e finché il ponte non risponde.

import { LEVELS, cleanReader, type GenerationMode, type Level, type ReaderProfile, type StoredPrefs } from "../shared/types";
import { SOUND_DEFAULTS, cleanSound, type SoundSettings } from "./audio";
import { LANGS, t, type Lang } from "./i18n";
import { BUILTIN_GUIDES, GUIDE_INFO, type BuiltinGuide } from "./portrait";

export interface GuideChoice {
  /** Ritratto predefinito o "custom": l'immagine dell'utente (salvata a parte, vedi guide.ts). */
  id: BuiltinGuide | "custom";
  name: string;
}

export interface Settings {
  /** Lingua dell'interfaccia; l'agente la riceve per scrivere nella stessa. */
  lang: Lang;
  level: Level;
  generation: GenerationMode;
  guide: GuideChoice;
  /** Risposte al questionario sull'accessibilità. */
  reader: ReaderProfile;
  /** Musica, effetti e voce della guida. */
  sound: SoundSettings;
  /** Moltiplicatore della dimensione del testo (A− / A+). */
  textScale: number;
  /** Finestra del gioco: larga, classica (più stretta, si vede lo sfondo) o libera (si ridimensiona dall'angolo). */
  frame: Frame;
}

export const FRAMES = ["larga", "classica", "libera"] as const;
export type Frame = (typeof FRAMES)[number];

export const TEXT_SCALE_MIN = 0.8;
export const TEXT_SCALE_MAX = 1.6;
export const TEXT_SCALE_STEP = 0.1;

/** Scala del testo valida: tra minimo e massimo, a passi di un decimo. */
export function cleanTextScale(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 1;
  return Math.round(Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, n)) * 10) / 10;
}

const KEY = "code-dungeon:settings";
const DEFAULTS: Settings = { lang: "en", level: "medio", generation: "istantanea", guide: { id: "lumen", name: GUIDE_INFO.lumen.name }, reader: { aids: [] }, sound: SOUND_DEFAULTS, textScale: 1, frame: "larga" };
const defaults = (): Settings => structuredClone(DEFAULTS);

/** Nome proposto per una guida: quello del ritratto predefinito, "Guide"/"Guida" per un'immagine propria. */
export const defaultGuideName = (id: GuideChoice["id"]): string => (id === "custom" ? t().msg.defaultGuide : GUIDE_INFO[id].name);

function readGuide(g: Partial<GuideChoice> | undefined): GuideChoice {
  // una guida che non esiste più (es. Bruno, sostituito da Patrizio) riparte dalla predefinita, nome compreso
  if (!g || !(g.id === "custom" || BUILTIN_GUIDES.includes(g.id as BuiltinGuide))) return { ...DEFAULTS.guide };
  const id = g.id!;
  const name = typeof g.name === "string" && g.name.trim() ? g.name.trim().slice(0, 20) : defaultGuideName(id);
  return { id, name };
}

/** Impostazioni valide da un oggetto qualsiasi (localStorage, database): i valori sconosciuti tornano predefiniti. */
function parseSettings(raw: unknown): Settings {
  const s = (raw ?? {}) as Partial<Settings>;
  return {
    lang: s.lang && LANGS.includes(s.lang) ? s.lang : DEFAULTS.lang,
    level: s.level && LEVELS.includes(s.level) ? s.level : DEFAULTS.level,
    generation: s.generation === "su_richiesta" ? "su_richiesta" : "istantanea",
    guide: readGuide(s.guide),
    reader: cleanReader(s.reader),
    sound: cleanSound(s.sound),
    textScale: cleanTextScale(s.textScale),
    frame: s.frame && FRAMES.includes(s.frame) ? s.frame : DEFAULTS.frame,
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseSettings(JSON.parse(raw)) : defaults();
  } catch {
    return defaults();
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // archiviazione non disponibile (finestra privata, anteprima): le impostazioni valgono per questa sessione
  }
}

/** true se il database del ponte non ha ancora niente: si parte da quello che c'è in questo browser. */
export const isEmpty = (p: StoredPrefs): boolean => !p.settings && !p.reader;

/** Le impostazioni salvate dal ponte. */
export function fromStored(p: StoredPrefs): Settings {
  return parseSettings({ ...p.settings, reader: p.reader });
}

export function toStored(s: Settings): StoredPrefs {
  return { settings: { lang: s.lang, level: s.level, generation: s.generation, guide: s.guide, sound: s.sound, textScale: s.textScale, frame: s.frame }, reader: s.reader };
}
