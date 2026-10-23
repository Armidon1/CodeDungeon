// Impostazioni del giocatore. Per ora in localStorage; nella tappa 7 passeranno a SQLite tramite il ponte.

import { LEVELS, type GenerationMode, type Level } from "../shared/types";

export interface Settings {
  level: Level;
  generation: GenerationMode;
}

const KEY = "code-dungeon:settings";
const DEFAULTS: Settings = { level: "medio", generation: "istantanea" };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      level: s.level && LEVELS.includes(s.level) ? s.level : DEFAULTS.level,
      generation: s.generation === "su_richiesta" ? "su_richiesta" : "istantanea",
    };
  } catch {
    return { ...DEFAULTS };
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
