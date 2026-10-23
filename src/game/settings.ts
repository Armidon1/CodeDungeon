// Impostazioni del giocatore. Per ora in localStorage; nella tappa 7 passeranno a SQLite tramite il ponte.

import { LEVELS, type GenerationMode, type Level } from "../shared/types";
import { BUILTIN_GUIDES, GUIDE_INFO, type BuiltinGuide } from "./portrait";

export interface GuideChoice {
  /** Ritratto predefinito o "custom": l'immagine dell'utente (salvata a parte, vedi guide.ts). */
  id: BuiltinGuide | "custom";
  name: string;
}

export interface Settings {
  level: Level;
  generation: GenerationMode;
  guide: GuideChoice;
}

const KEY = "code-dungeon:settings";
const DEFAULTS: Settings = { level: "medio", generation: "istantanea", guide: { id: "lumen", name: GUIDE_INFO.lumen.name } };

/** Nome proposto per una guida: quello del ritratto predefinito, "Guida" per un'immagine propria. */
export const defaultGuideName = (id: GuideChoice["id"]): string => (id === "custom" ? "Guida" : GUIDE_INFO[id].name);

function readGuide(g: Partial<GuideChoice> | undefined): GuideChoice {
  // una guida che non esiste più (es. Bruno, sostituito da Patrizio) riparte dalla predefinita, nome compreso
  if (!g || !(g.id === "custom" || BUILTIN_GUIDES.includes(g.id as BuiltinGuide))) return { ...DEFAULTS.guide };
  const id = g.id!;
  const name = typeof g.name === "string" && g.name.trim() ? g.name.trim().slice(0, 20) : defaultGuideName(id);
  return { id, name };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, guide: { ...DEFAULTS.guide } };
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      level: s.level && LEVELS.includes(s.level) ? s.level : DEFAULTS.level,
      generation: s.generation === "su_richiesta" ? "su_richiesta" : "istantanea",
      guide: readGuide(s.guide),
    };
  } catch {
    return { ...DEFAULTS, guide: { ...DEFAULTS.guide } };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // archiviazione non disponibile (finestra privata, anteprima): le impostazioni valgono per questa sessione
  }
}

export const LEVEL_INFO: Record<Level, { label: string; hint: string }> = {
  facile: { label: "Facile", hint: "Per chi non programma. Metafore, niente gergo." },
  medio: { label: "Medio", hint: "Termini tecnici di base, struttura e flusso." },
  difficile: { label: "Difficile", hint: "Dettagli implementativi e scelte di design." },
  arduo: { label: "Arduo", hint: "Basso livello: protocolli, flag, memoria, falle di sicurezza." },
};

export const GENERATION_INFO: Record<GenerationMode, { label: string; hint: string }> = {
  istantanea: { label: "Istantanea", hint: "Tutti i livelli pronti subito: cambio immediato, più token." },
  su_richiesta: { label: "Su richiesta", hint: "Solo il livello scelto: meno token, qualche secondo d'attesa quando cambi." },
};
