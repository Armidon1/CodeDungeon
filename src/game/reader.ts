// Adattamenti del gioco scelti nel questionario: font, dimensione del testo, movimento, fumetti a pagine.
// Gli altri aiuti (frasi brevi, schemi, esempi, termini) li applica l'agente quando scrive.

import type { ReaderProfile } from "../shared/types";

let profile: ReaderProfile = { aids: [] };

export function applyReader(p: ReaderProfile): void {
  profile = p;
  const root = document.documentElement.classList;
  root.toggle("font-leggibile", p.aids.includes("font_leggibile"));
  root.toggle("testo-grande", p.aids.includes("testo_grande"));
  root.toggle("meno-movimento", p.aids.includes("meno_movimento"));
}

const systemReduced = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Movimento ridotto: dal sistema operativo o dal questionario. */
export const reducedMotion = (): boolean => profile.aids.includes("meno_movimento") || systemReduced.matches;

/** Lunghezza massima di una pagina del fumetto con "poco testo per volta". */
const PAGE = 160;

/**
 * Divide un testo in pagine corte, tagliando tra le frasi (una frase più lunga resta intera).
 * Senza "poco testo per volta" resta una pagina sola.
 */
export function pages(text: string): string[] {
  if (!profile.aids.includes("poco_testo") || text.length <= PAGE) return [text];
  const sentences = text
    .split(/\n\s*\n/)
    .flatMap((para) => para.match(/[^.!?…:]+(?:[.!?…:]+["»)]?|$)\s*/g) ?? [para])
    .map((x) => x.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    const last = out.at(-1);
    if (last !== undefined && last.length + 1 + s.length <= PAGE) out[out.length - 1] = `${last} ${s}`;
    else out.push(s);
  }
  return out.length ? out : [text];
}
