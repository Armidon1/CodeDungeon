// Evidenziazione della sintassi minimale, riga per riga, per Python e JavaScript/TypeScript.
// Restituisce HTML già escapato.

const PY_KEYWORDS = new Set(
  "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split(" "),
);
const PY_CONSTANTS = new Set(["True", "False", "None", "self"]);
const PY_BUILTINS = new Set(
  "print len range dict list set tuple str int bytes bytearray isinstance super open enumerate zip map filter sorted min max sum any all getattr setattr hasattr type object Exception ValueError TypeError KeyError ConnectionError".split(" "),
);
const JS_KEYWORDS = new Set(
  "const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of interface type implements enum as readonly private public protected static".split(" "),
);
const JS_CONSTANTS = new Set(["true", "false", "null", "undefined", "this"]);

export type Lang = "python" | "js" | "json" | "text";

export function langOf(path: string): Lang {
  if (/\.py$/i.test(path)) return "python";
  if (/\.(m?[jt]sx?|cjs)$/i.test(path)) return "js";
  if (/\.json$/i.test(path)) return "json";
  return "text";
}

export function langLabel(lang: Lang): string {
  return { python: "Python", js: "JavaScript", json: "JSON", text: "Testo" }[lang];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls: string, s: string) => `<span class="tk-${cls}">${esc(s)}</span>`;

/** Evidenzia tutte le righe di un file; gestisce le stringhe su più righe. */
export function highlightLines(source: string, lang: Lang): string[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lang === "text") return lines.map(esc);
  let openTriple: string | null = null; // stringa """ o ''' ancora aperta (Python) o `...` (JS)
  return lines.map((line) => {
    let out = "";
    let i = 0;
    if (openTriple) {
      const end = line.indexOf(openTriple);
      if (end === -1) return span("str", line);
      out += span("str", line.slice(0, end + openTriple.length));
      i = end + openTriple.length;
      openTriple = null;
    }
    let prevWord = "";
    while (i < line.length) {
      const rest = line.slice(i);
      const ch = line[i];
      // commenti
      if ((lang === "python" && ch === "#") || (lang === "js" && rest.startsWith("//"))) {
        out += span("com", rest);
        break;
      }
      // stringhe su più righe
      const triple = lang === "python" ? rest.match(/^[rbfu]{0,2}("""|''')/i) : lang === "js" && ch === "`" ? ["`", "`"] : null;
      if (triple) {
        const q = triple[1];
        const startLen = triple[0].length;
        const end = line.indexOf(q, i + startLen);
        if (end === -1) {
          out += span("str", rest);
          openTriple = q;
          break;
        }
        out += span("str", line.slice(i, end + q.length));
        i = end + q.length;
        continue;
      }
      // stringhe su una riga
      const strStart =
        ch === '"' || ch === "'" || (lang === "python" && /^[rbfu]{1,2}["']/i.test(rest) && !/\w/.test(line[i - 1] ?? ""));
      if (strStart) {
        const str = rest.match(/^[rbfu]{0,2}("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)/i)!;
        out += span("str", str[0]);
        i += str[0].length;
        continue;
      }
      // numeri
      const num = rest.match(/^(0x[0-9a-f_]+|\d[\d_]*(\.\d+)?)/i);
      if (num && !/[\w]/.test(line[i - 1] ?? "")) {
        out += span("num", num[0]);
        i += num[0].length;
        continue;
      }
      // decoratori
      if (lang === "python" && ch === "@" && /^@\w/.test(rest)) {
        const m = rest.match(/^@[\w.]+/)!;
        out += span("dec", m[0]);
        i += m[0].length;
        continue;
      }
      // parole
      const word = rest.match(/^[A-Za-z_]\w*/);
      if (word) {
        const w = word[0];
        const kw = lang === "python" ? PY_KEYWORDS : JS_KEYWORDS;
        const consts = lang === "python" ? PY_CONSTANTS : JS_CONSTANTS;
        let cls = "";
        if (lang === "json") cls = consts.has(w) ? "kw" : "";
        else if (kw.has(w)) cls = "kw";
        else if (consts.has(w)) cls = "const";
        else if (prevWord === "def" || prevWord === "class" || prevWord === "function") cls = "def";
        else if (/^[A-Z][A-Z0-9_]+$/.test(w)) cls = "const";
        else if (lang === "python" && PY_BUILTINS.has(w)) cls = "builtin";
        else if (line[i + w.length] === "(") cls = "call";
        out += cls ? span(cls, w) : esc(w);
        prevWord = w;
        i += w.length;
        continue;
      }
      if (ch !== " " && ch !== "\t") prevWord = "";
      out += esc(ch);
      i++;
    }
    return out;
  });
}
