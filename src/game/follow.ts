// Ctrl+clic su un file incluso o importato: dalla riga di codice al file del progetto.
// Si cerca solo nell'elenco dei file che manda il ponte (già confinato nella radice da resolveInside):
// niente letture nuove, e un percorso che esce dal progetto non porta da nessuna parte.
// Le intestazioni di sistema (#include <stdio.h>) e i moduli installati non si aprono.

const dirOf = (file: string) => file.split("/").slice(0, -1).join("/");

/** Unisce e normalizza; undefined se il percorso esce dalla radice o è assoluto. */
function join(base: string, rel: string): string | undefined {
  if (rel.startsWith("/") || /^[a-z]+:/i.test(rel)) return undefined;
  const out = base ? base.split("/") : [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** I possibili file di una riga, dal più probabile. */
function candidates(line: string, file: string): string[] {
  const here = dirOf(file);
  const out: (string | undefined)[] = [];
  // C e C++: #include "util.h" (dalla cartella del file, poi dalla radice); <...> è di sistema
  const inc = /^\s*#\s*(?:include|import)\s*"([^"]+)"/.exec(line);
  if (inc) out.push(join(here, inc[1]), join("", inc[1]));

  // JavaScript e TypeScript: solo percorsi relativi (i pacchetti di node_modules non si aprono)
  for (const m of line.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
    const base = join(here, m[1]);
    if (!base) continue;
    const stem = base.replace(/\.(?:js|mjs|cjs|jsx)$/, "");
    out.push(base);
    for (const ext of [".ts", ".tsx", ".js", ".mjs", ".jsx", ".d.ts"]) out.push(stem + ext);
    for (const ext of [".ts", ".tsx", ".js"]) out.push(`${base}/index${ext}`);
  }

  // Python: from a.b import c, from .x import y, import a.b
  const py = /^\s*from\s+(\.*)([\w.]*)\s+import\s+([\w, ]+)/.exec(line) ?? /^\s*import\s+()([\w.]+)/.exec(line);
  if (py) {
    const [, dots, mod, names] = py;
    // from . import x: "." risale di livello in livello (un punto = la cartella del file)
    let base: string | undefined = dots ? here : "";
    for (let i = 1; i < dots.length && base !== undefined; i++) base = join(base, "..");
    if (base !== undefined) {
      const roots = dots ? [base] : [here, ""];
      for (const root of roots) {
        const path = mod ? join(root, mod.split(".").join("/")) : root;
        if (path === undefined) continue;
        // from pacchetto import modulo: prima il modulo, poi il pacchetto
        for (const name of (names ?? "").split(",").map((n) => n.trim().split(/\s+/)[0]).filter(Boolean)) {
          out.push(join(path, `${name}.py`));
        }
        if (mod) out.push(`${path}.py`, `${path}/__init__.py`);
      }
    }
  }

  // altrimenti: una stringa tra virgolette che è il percorso di un file del progetto
  for (const m of line.matchAll(/["']([\w./-]+\.\w+)["']/g)) out.push(join(here, m[1]), join("", m[1]));
  return out.filter((x): x is string => !!x && x !== file);
}

/** Il file del progetto a cui porta la riga, se c'è. */
export function followTarget(line: string, file: string, files: readonly string[]): string | undefined {
  const known = new Set(files);
  return candidates(line, file).find((c) => known.has(c));
}
