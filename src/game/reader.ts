// Adattamenti del gioco scelti nel questionario: font, movimento, fumetti a pagine (la dimensione del testo è textScale).
// Gli altri aiuti (frasi brevi, schemi, esempi, termini) li applica l'agente quando scrive.

import type { ReaderProfile } from "../shared/types";
import { FENCE } from "./richtext";

let profile: ReaderProfile = { aids: [] };

export function applyReader(p: ReaderProfile): void {
  const wasReduced = reducedMotion();
  profile = p;
  const root = document.documentElement.classList;
  root.toggle("font-leggibile", p.aids.includes("font_leggibile"));
  root.toggle("meno-movimento", p.aids.includes("meno_movimento"));
  if (wasReduced !== reducedMotion()) motionChanges.dispatchEvent(new Event("change"));
}

const systemReduced = window.matchMedia("(prefers-reduced-motion: reduce)");

export const motionChanges = new EventTarget();
systemReduced.addEventListener("change", () => motionChanges.dispatchEvent(new Event("change")));

/** Movimento ridotto: dal sistema operativo o dal questionario. */
export const reducedMotion = (): boolean => profile.aids.includes("meno_movimento") || systemReduced.matches;

/** Lunghezza massima di una pagina del fumetto con "poco testo per volta". */
const PAGE = 160;

/** Frasi di una riga: la fine è . ! ? … : seguita da uno spazio, mai dentro un `codice` (indirizzi e numeri restano interi). */
function sentences(line: string): string[] {
  const out: string[] = [];
  let from = 0;
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "`") inCode = !inCode;
    if (inCode || !/[.!?…:]/.test(c)) continue;
    let j = i + 1;
    while (j < line.length && /[.!?…:"»)]/.test(line[j])) j++;
    if (j < line.length && !/\s/.test(line[j])) continue;
    out.push(line.slice(from, j).trim());
    from = i = j;
  }
  out.push(line.slice(from).trim());
  return out.filter(Boolean);
}

/**
 * Divide un testo in pagine corte, tagliando tra le frasi e tra i punti degli elenchi
 * (una frase più lunga resta intera). Gli a capo restano. Senza "poco testo per volta" resta una pagina sola.
 */
export function pages(text: string): string[] {
  if (!profile.aids.includes("poco_testo") || text.length <= PAGE) return [text];
  // pezzi col separatore che li precede: spazio nella stessa riga, a capo tra righe, riga vuota tra paragrafi
  const parts: { sep: string; text: string }[] = [];
  let sep = "";
  /** Blocco di codice in corso: resta un pezzo solo, righe vuote comprese. */
  let code: { fence: string; lines: string[] } | undefined;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const f = FENCE.exec(line);
    if (code) {
      code.lines.push(line);
      if (f && f[1][0] === code.fence[0] && f[1].length >= code.fence.length && !f[2]) {
        parts.push({ sep, text: code.lines.join("\n") });
        code = undefined;
        sep = "\n";
      }
      continue;
    }
    if (f) {
      if (parts.length && sep !== "\n\n") sep = "\n";
      code = { fence: f[1], lines: [line] };
      continue;
    }
    if (!line.trim()) {
      if (parts.length) sep = "\n\n";
      continue;
    }
    // un punto d'elenco è un pezzo solo, come una frase
    const units = /^\s*(?:[-*•·]|\d{1,3}[.)])\s+/.test(line) ? [line.trimEnd()] : sentences(line);
    for (const u of units) {
      parts.push({ sep, text: u });
      sep = " ";
    }
    sep = sep === "\n\n" ? sep : "\n";
  }
  if (code) parts.push({ sep, text: code.lines.join("\n") });
  const out: string[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (last !== undefined && last.length + p.sep.length + p.text.length <= PAGE) out[out.length - 1] = last + p.sep + p.text;
    else out.push(p.text);
  }
  return out.length ? out : [text];
}
