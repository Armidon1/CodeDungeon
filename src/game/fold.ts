// Blocchi ripiegabili dell'editor, come le freccette di VS Code accanto a funzioni, classi, cicli.
// Linguaggi con le graffe: da una riga che apre { o [ alla riga prima di quella che chiude (la chiusura resta visibile).
// Gli altri (Python, YAML, Markdown...): dal rientro, una riga seguita da righe più rientrate.
// Numeri di riga da 1; un blocco nasconde le righe start+1..end.

import type { Lang } from "./highlight";

/** Riga d'inizio → ultima riga nascosta. */
export type FoldMap = Map<number, number>;

const BRACES = new Set<Lang>(["c", "cpp", "csharp", "java", "kotlin", "go", "rust", "swift", "js", "ts", "php", "json", "css"]);

export function foldRanges(text: string, lang: Lang): FoldMap {
  const lines = text.split("\n");
  return BRACES.has(lang) ? braceRanges(lines, lang) : indentRanges(lines);
}

function braceRanges(lines: string[], lang: Lang): FoldMap {
  const out: FoldMap = new Map();
  const stack: number[] = [];
  let block = false;
  let str = "";
  const hash = lang === "php";
  for (let n = 1; n <= lines.length; n++) {
    const l = lines[n - 1];
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (block) {
        if (c === "*" && l[i + 1] === "/") {
          block = false;
          i++;
        }
      } else if (str) {
        if (c === "\\") i++;
        else if (c === str) str = "";
      } else if (c === "/" && l[i + 1] === "/") break;
      else if (hash && c === "#") break;
      else if (c === "/" && l[i + 1] === "*") {
        block = true;
        i++;
      } else if (c === '"' || c === "'" || c === "`") str = c;
      else if (c === "{" || c === "[") stack.push(n);
      else if ((c === "}" || c === "]") && stack.length) {
        const start = stack.pop()!;
        // la riga della chiusura resta visibile, a meno che dopo la parentesi ci sia altro codice da nascondere
        const end = /^\s*[}\]]/.test(l) ? n - 1 : n;
        if (end > start) out.set(start, Math.max(out.get(start) ?? 0, end));
      }
    }
    // le stringhe a una riga non continuano; i template di JS e TS sì
    if (str && str !== "`") str = "";
  }
  return out;
}

function indentRanges(lines: string[]): FoldMap {
  const out: FoldMap = new Map();
  const indent = (l: string) => {
    let w = 0;
    for (const c of l) {
      if (c === " ") w++;
      else if (c === "\t") w += 4;
      else break;
    }
    return w;
  };
  const stack: { n: number; d: number }[] = [];
  let prev = 0;
  const close = (d: number) => {
    while (stack.length && stack[stack.length - 1].d >= d) {
      const top = stack.pop()!;
      if (prev > top.n) out.set(top.n, prev);
    }
  };
  for (let n = 1; n <= lines.length; n++) {
    const l = lines[n - 1];
    if (!l.trim()) continue;
    const d = indent(l);
    close(d);
    stack.push({ n, d });
    prev = n;
  }
  close(-1);
  return out;
}
