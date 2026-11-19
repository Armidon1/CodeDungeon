// Testo della guida con una formattazione minima: paragrafi, a capo, elenchi (- o 1.),
// `codice`, **grassetto**, [etichetta](https://...) e indirizzi nudi.
// Tutto costruito con nodi DOM (mai innerHTML): il testo arriva dall'agente.

type Inline = { kind: "text" | "code" | "bold"; text: string } | { kind: "link"; text: string; href: string };
type Line = Inline[];
type Block = { kind: "p"; lines: Line[] } | { kind: "ul" | "ol"; items: { n?: number; lines: Line[] }[] };

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
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
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
    } else if (cur && cur.kind !== "p" && /^\s/.test(raw)) {
      // riga rientrata sotto un punto: continua quel punto
      cur.items.at(-1)!.lines.push(inline(raw.trim()));
    } else {
      if (cur?.kind !== "p") blocks.push((cur = { kind: "p", lines: [] }));
      cur.lines.push(inline(raw.trim()));
    }
  }
  return blocks;
}

const lineText = (l: Line) => l.map((x) => x.text).join("");

/** Righe visibili nell'ordine di lettura, con o senza i segni degli elenchi. */
function plainLines(blocks: Block[], markers: boolean): string[] {
  return blocks.flatMap((b) =>
    b.kind === "p"
      ? b.lines.map(lineText)
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
