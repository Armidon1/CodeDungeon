// Testo della guida con una formattazione minima: paragrafi, a capo, elenchi (- o 1.),
// `codice`, blocchi ```linguaggio ... ``` (con i colori dell'editor e un pulsante per copiarli),
// **grassetto**, [etichetta](https://...) e indirizzi nudi.
// Tutto costruito con nodi DOM: il testo arriva dall'agente. L'unico HTML è quello di highlightLines,
// che passa ogni pezzo di testo da esc().

import { highlightLines, langLabel, langOf, type Lang } from "./highlight";
import { t } from "./i18n";

type Inline = { kind: "text" | "code" | "bold"; text: string } | { kind: "link"; text: string; href: string };
type Line = Inline[];
type Block =
  | { kind: "p"; lines: Line[] }
  | { kind: "ul" | "ol"; items: { n?: number; lines: Line[] }[] }
  | { kind: "code"; lang: Lang; tag: string; lines: string[] };

/** Riga che apre o chiude un blocco di codice: ``` con il nome del linguaggio facoltativo. */
export const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;

/** Nomi dopo ``` che non coincidono con un'estensione. */
const FENCE_LANG: Record<string, Lang> = {
  python: "python", py3: "python", "c++": "cpp", "c#": "csharp", csharp: "csharp", javascript: "js", node: "js",
  typescript: "ts", rust: "rust", golang: "go", shell: "shell", console: "shell", shellsession: "shell", terminal: "shell",
  assembly: "asm", x86: "asm", x86asm: "asm", gas: "asm", kotlin: "kotlin", ruby: "ruby", haskell: "haskell",
  make: "make", makefile: "make", dockerfile: "docker", docker: "docker", yml: "yaml", html: "html", xhtml: "html",
  jsonc: "json", json5: "json", text: "text", txt: "text", plain: "text", plaintext: "text",
};

function fenceLang(tag: string): Lang {
  const k = tag.toLowerCase();
  return FENCE_LANG[k] ?? langOf(`x.${k}`);
}

/** Toglie il rientro comune (un blocco dentro un punto d'elenco è rientrato tutto). */
function dedent(lines: string[]): string[] {
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return Number.isFinite(pad) && pad > 0 ? lines.map((l) => l.slice(pad)) : lines;
}

const BULLET = /^\s*[-*•·]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"«»`]+)/g;

function inline(src: string): Line {
  const out: Line = [];
  let at = 0;
  for (const m of src.matchAll(INLINE)) {
    let whole = m[0];
    let tail = "";
    if (m[5] !== undefined) {
      // la punteggiatura dopo un indirizzo resta fuori dal link
      const cut = /[.,;:!?)\]'’]+$/.exec(whole);
      if (cut && !(cut[0].includes(")") && whole.includes("("))) {
        tail = cut[0];
        whole = whole.slice(0, -tail.length);
      }
    }
    if (m.index > at) out.push({ kind: "text", text: src.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "bold", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "link", text: m[3], href: m[4] });
    else out.push({ kind: "link", text: whole, href: whole });
    if (tail) out.push({ kind: "text", text: tail });
    at = m.index + m[0].length;
  }
  if (at < src.length) out.push({ kind: "text", text: src.slice(at) });
  return out;
}

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | undefined;
  /** Blocco di codice aperto e la sua recinzione (si chiude con la stessa, anche più lunga). */
  let code: { block: Extract<Block, { kind: "code" }>; fence: string } | undefined;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const f = FENCE.exec(raw);
    if (code) {
      if (f && f[1][0] === code.fence[0] && f[1].length >= code.fence.length && !f[2]) {
        code.block.lines = dedent(code.block.lines);
        code = undefined;
      } else code.block.lines.push(raw.replace(/\t/g, "    "));
      continue;
    }
    if (f) {
      const block = { kind: "code" as const, lang: fenceLang(f[2]), tag: f[2], lines: [] as string[] };
      blocks.push(block);
      code = { block, fence: f[1] };
      cur = undefined;
      continue;
    }
    if (!raw.trim()) {
      cur = undefined;
      continue;
    }
    const b = BULLET.exec(raw);
    const n = b ? undefined : NUMBER.exec(raw);
    if (b || n) {
      const kind = b ? "ul" : "ol";
      if (cur?.kind !== kind) blocks.push((cur = { kind, items: [] }));
      cur.items.push({ n: n ? Number(n[1]) : undefined, lines: [inline((b ?? n)![b ? 1 : 2])] });
    } else if (cur && (cur.kind === "ul" || cur.kind === "ol") && /^\s/.test(raw)) {
      // riga rientrata sotto un punto: continua quel punto
      cur.items.at(-1)!.lines.push(inline(raw.trim()));
    } else {
      if (cur?.kind !== "p") blocks.push((cur = { kind: "p", lines: [] }));
      cur.lines.push(inline(raw.trim()));
    }
  }
  if (code) code.block.lines = dedent(code.block.lines);
  // le righe vuote in fondo a un blocco non si mostrano
  for (const b of blocks) if (b.kind === "code") while (b.lines.length > 1 && !b.lines.at(-1)!.trim()) b.lines.pop();
  return blocks;
}

const lineText = (l: Line) => l.map((x) => x.text).join("");

/** Righe visibili nell'ordine di lettura, con o senza i segni degli elenchi. */
function plainLines(blocks: Block[], markers: boolean): string[] {
  return blocks.flatMap((b) =>
    b.kind === "p"
      ? b.lines.map(lineText)
      : b.kind === "code"
        ? b.lines
        : b.items.flatMap((it, i) =>
          it.lines.map((l, j) => (markers && j === 0 ? (b.kind === "ul" ? "• " : `${it.n ?? i + 1}. `) : "") + lineText(l)),
        ),
  );
}

/** Il testo come lo si legge, senza segni di formattazione: per la macchina da scrivere. */
export function richPlain(text: string): string {
  return plainLines(parse(text), false).join("\n");
}

/** Il testo per i lettori di schermo: come richPlain, con i numeri e i punti degli elenchi. */
export function richSpoken(text: string): string {
  return plainLines(parse(text), true).join("\n");
}

/**
 * Riempie el con il testo formattato. Con limit mostra solo i primi limit caratteri di richPlain
 * (ogni a capo conta uno): la macchina da scrivere scrive dentro la formattazione.
 */
export function renderRich(el: HTMLElement, text: string, limit = Infinity): void {
  let left = limit;
  const frag = document.createDocumentFragment();
  let first = true;
  /** Consuma un a capo tra due righe; false quando il testo da mostrare è finito. */
  const gap = (): boolean => {
    if (!first) left -= 1;
    first = false;
    return left > 0;
  };
  const fill = (into: HTMLElement, line: Line): void => {
    for (const part of line) {
      if (left <= 0) return;
      const shown = part.text.slice(0, left);
      left -= shown.length;
      if (part.kind === "text") {
        into.append(shown);
        continue;
      }
      const node =
        part.kind === "code" ? document.createElement("code")
        : part.kind === "bold" ? document.createElement("strong")
        : document.createElement("a");
      node.textContent = shown;
      if (part.kind === "link") {
        const a = node as HTMLAnchorElement;
        a.href = part.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "rich-link";
      }
      into.append(node);
    }
  };
  const lines = (into: HTMLElement, ls: Line[]): boolean => {
    for (const [i, l] of ls.entries()) {
      if (!gap()) return false;
      if (i > 0) into.append(document.createElement("br"));
      fill(into, l);
    }
    return true;
  };
  for (const b of parse(text)) {
    if (b.kind === "code") {
      const box = codeBlock(b);
      const pre = box.querySelector("code")!;
      const hl = highlightLines(b.lines.join("\n"), b.lang);
      let more = true;
      for (const [i, line] of b.lines.entries()) {
        if (!gap()) {
          more = false;
          break;
        }
        const row = document.createElement("span");
        row.className = "rich-code-line";
        if (i > 0) pre.append("\n");
        if (line.length <= left) row.innerHTML = hl[i];
        else row.textContent = line.slice(0, left);
        left -= Math.min(line.length, left);
        pre.append(row);
        if (left <= 0 && i < b.lines.length - 1) {
          more = false;
          break;
        }
      }
      if (pre.childNodes.length) frag.append(box);
      if (!more) break;
      continue;
    }
    if (b.kind === "p") {
      const p = document.createElement("p");
      const more = lines(p, b.lines);
      if (p.childNodes.length) frag.append(p);
      if (!more) break;
      continue;
    }
    const list = document.createElement(b.kind);
    let more = true;
    for (const it of b.items) {
      const li = document.createElement("li");
      if (it.n !== undefined) li.value = it.n;
      more = lines(li, it.lines);
      if (li.childNodes.length) list.append(li);
      if (!more) break;
    }
    if (list.childNodes.length) frag.append(list);
    if (!more) break;
  }
  el.replaceChildren(frag);
  el.classList.add("rich");
}

/** Cornice del blocco di codice: linguaggio, pulsante per copiarlo, righe colorate come nell'editor. */
function codeBlock(b: Extract<Block, { kind: "code" }>): HTMLElement {
  const box = document.createElement("div");
  box.className = "rich-code";
  const head = document.createElement("div");
  head.className = "rich-code-head";
  const label = document.createElement("span");
  label.className = "rich-code-lang";
  label.textContent = b.lang === "text" ? b.tag || t().msg.plainText : langLabel(b.lang);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "rich-copy";
  copy.textContent = t().ui.copyCode;
  copy.title = t().ui.copyCodeTitle;
  const source = b.lines.join("\n");
  copy.addEventListener("click", (e) => {
    e.stopPropagation();
    void copyText(source).then((ok) => {
      copy.textContent = ok ? t().ui.codeCopied : t().ui.copyFailed;
      copy.classList.toggle("is-copied", ok);
      setTimeout(() => {
        copy.textContent = t().ui.copyCode;
        copy.classList.remove("is-copied");
      }, 1500);
    });
  });
  head.append(label, copy);
  const pre = document.createElement("pre");
  pre.className = "rich-code-body";
  pre.append(document.createElement("code"));
  box.append(head, pre);
  return box;
}

/** Copia negli appunti; se l'API non c'è o è negata (alcune webview), ripiega su execCommand. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
