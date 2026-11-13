// Modalità tutor: cosa accompagna una domanda (buffer dell'editor, righe cambiate) e le scelte rapide.

import { BUFFER_MAX, CHANGED_MAX, type TutorBuffer } from "../shared/types";

export const QUICK_ASKS = ["hint", "check", "error"] as const;
export type QuickAsk = (typeof QUICK_ASKS)[number];

/** Oltre questa dimensione (righe × righe) il confronto si limita a inizio e fine comuni. */
const LCS_MAX_CELLS = 4_000_000;

/**
 * Righe di `after` cambiate rispetto a `before` (aggiunte o modificate), come intervalli inclusi da 1.
 * Confronto riga per riga con la sottosequenza comune più lunga; sui file enormi, un solo intervallo
 * tra l'inizio e la fine in comune. Le righe solo tolte segnano la riga dove stavano.
 */
export function changedLines(before: string, after: string): [number, number][] {
  if (before === after) return [];
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const changed: boolean[] = new Array(midB.length).fill(false);
  const removedAt = new Set<number>();
  if (midA.length * midB.length > LCS_MAX_CELLS) {
    changed.fill(true);
    if (!midB.length) removedAt.add(0);
  } else {
    // tabella della sottosequenza comune più lunga, poi si risale segnando le righe di b fuori da essa
    const n = midA.length;
    const m = midB.length;
    const t = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * (m + 1) + j] = midA[i] === midB[j] ? t[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(t[(i + 1) * (m + 1) + j], t[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        i++;
        j++;
      } else if (j < m && (i >= n || t[i * (m + 1) + j + 1] >= t[(i + 1) * (m + 1) + j])) {
        changed[j++] = true;
      } else {
        removedAt.add(j);
        i++;
      }
    }
  }
  const lines = new Set<number>();
  changed.forEach((c, j) => c && lines.add(start + j + 1));
  // una riga tolta segna la riga che ora sta al suo posto (o l'ultima, se era in fondo)
  // (se accanto c'è già una riga cambiata, era una sostituzione: basta quella)
  for (const j of removedAt) if (!changed[j - 1] && !changed[j]) lines.add(Math.max(1, Math.min(start + j + 1, b.length)));
  const sorted = [...lines].sort((x, y) => x - y);
  const ranges: [number, number][] = [];
  for (const l of sorted) {
    const last = ranges.at(-1);
    if (last && l === last[1] + 1) last[1] = l;
    else ranges.push([l, l]);
  }
  return ranges.slice(0, CHANGED_MAX);
}

/** Il buffer da allegare a una domanda, tagliato a BUFFER_MAX. */
export function tutorBuffer(file: string, content: string, dirty: boolean): TutorBuffer {
  return content.length > BUFFER_MAX ? { file, content: content.slice(0, BUFFER_MAX), dirty, truncated: true } : { file, content, dirty };
}
