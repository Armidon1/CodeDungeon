// La lavagna: disegna uno schema (flusso o sequenza) in pixel art su un canvas a bassa risoluzione,
// ingrandito senza sfumature. Le etichette sono testo vero sopra il canvas: nitide e leggibili dagli screen reader.
// Il disegno è progressivo: i pezzi nuovi compaiono uno alla volta e la mini guida percorre le frecce.

import { diagramPieces, type Diagram, type DiagramEdge, type DiagramNode } from "../shared/types";
import { drawMiniLumen } from "./portrait";

type Pt = [number, number];

const LABEL_FONT = 15; // px CSS, come .board-node
const LABEL_LINE = 18;
const EDGE_FONT = 13; // px CSS, come .board-edge
const MAX_LABEL_W = 150;

interface NodeBox {
  node: DiagramNode;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
}

interface EdgePath {
  edge: DiagramEdge;
  /** Pixel della linea, dal primo all'ultimo. */
  px: Pt[];
  /** Direzione della punta all'arrivo. */
  dir: "giu" | "destra" | "sinistra";
  label?: { x: number; y: number; center?: boolean };
}

interface Layout {
  w: number;
  h: number;
  nodes: NodeBox[];
  edges: EdgePath[];
  /** Linee della vita (sequenza): x, y iniziale e finale. */
  lifelines: [number, number, number][];
}

/** Cosa è visibile: nodi mostrati e quanto di ogni arco è tracciato (0..1). */
interface Shown {
  nodes: boolean[];
  edges: number[];
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

let measurer: CanvasRenderingContext2D | undefined;
function textWidth(text: string, size: number): number {
  measurer ??= document.createElement("canvas").getContext("2d")!;
  measurer.font = `${size}px ${getComputedStyle(document.body).fontFamily}`;
  return measurer.measureText(text).width;
}

/** Va a capo sulle parole entro la larghezza massima. */
function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && textWidth(next, LABEL_FONT) > max) {
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** Pixel di una spezzata ortogonale, senza ripetere gli angoli. */
function raster(points: Pt[]): Pt[] {
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    let [x, y] = points[i - 1];
    const [tx, ty] = points[i];
    while (x !== tx || y !== ty) {
      x += Math.sign(tx - x);
      y += Math.sign(ty - y);
      out.push([x, y]);
    }
  }
  return out;
}

// ---------- Impaginazione ----------

function measureNodes(d: Diagram, scale: number): NodeBox[] {
  return d.nodes.map((node) => {
    const lines = wrap(node.label, MAX_LABEL_W);
    const textW = Math.max(...lines.map((l) => textWidth(l, LABEL_FONT)));
    const extra = node.shape === "bivio" ? 8 : node.shape === "attore" ? 7 : 0;
    const capH = node.shape === "archivio" ? 6 : 0;
    return {
      node,
      x: 0,
      y: 0,
      w: Math.ceil(textW / scale) + 8 + extra,
      h: Math.ceil((lines.length * LABEL_LINE) / scale) + 6 + capH,
      lines,
    };
  });
}

function layoutFlow(d: Diagram, scale: number): Layout {
  const boxes = measureNodes(d, scale);
  const index = new Map(d.nodes.map((n, i) => [n.id, i]));
  const out = d.nodes.map(() => [] as number[]);
  d.edges.forEach((e, i) => out[index.get(e.from)!].push(i));

  // archi all'indietro: quelli che chiudono un ciclo nella visita in profondità (nell'ordine dei nodi)
  const back = new Set<number>();
  const state = d.nodes.map(() => 0); // 0 da visitare, 1 in corso, 2 fatto
  const visit = (n: number) => {
    state[n] = 1;
    for (const ei of out[n]) {
      const t = index.get(d.edges[ei].to)!;
      if (state[t] === 1) back.add(ei);
      else if (state[t] === 0) visit(t);
    }
    state[n] = 2;
  };
  d.nodes.forEach((_, i) => state[i] === 0 && visit(i));

  // righe: cammino più lungo dalle sorgenti
  const rank = d.nodes.map(() => 0);
  for (let changed = true, guard = 0; changed && guard < d.nodes.length + 1; guard++) {
    changed = false;
    d.edges.forEach((e, i) => {
      if (back.has(i)) return;
      const a = index.get(e.from)!;
      const b = index.get(e.to)!;
      if (rank[b] < rank[a] + 1) {
        rank[b] = rank[a] + 1;
        changed = true;
      }
    });
  }
  const rows: number[][] = [];
  rank.forEach((r, i) => (rows[r] ??= []).push(i));
  for (let r = 0; r < rows.length; r++) rows[r] ??= [];

  // ordine nella riga: baricentro dei genitori, due passate
  const pos = new Map<number, number>();
  const placeRow = (r: number) => rows[r].forEach((n, i) => pos.set(n, i));
  placeRow(0);
  for (let r = 1; r < rows.length; r++) {
    const bary = (n: number) => {
      const ps = d.edges.filter((e, i) => !back.has(i) && index.get(e.to) === n).map((e) => pos.get(index.get(e.from)!) ?? 0);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : (pos.get(n) ?? 0);
    };
    rows[r].sort((a, b) => bary(a) - bary(b) || a - b);
    placeRow(r);
  }

  // corsie: a sinistra gli archi che saltano righe, a destra quelli all'indietro
  const kind = d.edges.map((e, i) => {
    const a = index.get(e.from)!;
    const b = index.get(e.to)!;
    if (back.has(i) || rank[b] <= rank[a]) return "indietro" as const;
    return rank[b] - rank[a] > 1 ? ("salto" as const) : ("vicino" as const);
  });
  const leftLanes = kind.filter((k) => k === "salto").length;
  const rightLanes = kind.filter((k) => k === "indietro").length;

  // canali tra le righe: canale r sta sotto la riga r; -1 sopra la prima
  const slots = new Map<number, number>();
  const labelChan = new Set<number>();
  const slotOf: { out: number; in: number }[] = [];
  const take = (ch: number) => {
    const s = slots.get(ch) ?? 0;
    slots.set(ch, s + 1);
    return s;
  };
  d.edges.forEach((e, i) => {
    const ra = rank[index.get(e.from)!];
    const rb = rank[index.get(e.to)!];
    const so = take(ra);
    const si = kind[i] === "vicino" ? so : take(rb - 1);
    slotOf.push({ out: so, in: si });
    if (e.label) labelChan.add(rb - 1);
  });
  const labelH = Math.ceil((EDGE_FONT + 4) / scale);
  const chanH = (ch: number) => (slots.has(ch) || labelChan.has(ch) ? 5 + 2 * (slots.get(ch) ?? 0) + (labelChan.has(ch) ? labelH : 3) : 0);

  const gapX = 8;
  const rowW = rows.map((row) => row.reduce((s, n) => s + boxes[n].w, 0) + gapX * Math.max(0, row.length - 1));
  const inner = Math.max(...rowW, 20);
  const x0 = 4 + (leftLanes ? 2 * leftLanes + 3 : 0);
  let y = 4 + chanH(-1);
  const rowTop: number[] = [];
  const rowH: number[] = [];
  rows.forEach((row, r) => {
    rowTop[r] = y;
    rowH[r] = Math.max(0, ...row.map((n) => boxes[n].h));
    let x = x0 + Math.floor((inner - rowW[r]) / 2);
    for (const n of row) {
      boxes[n].x = x;
      boxes[n].y = y + Math.floor((rowH[r] - boxes[n].h) / 2);
      x += boxes[n].w + gapX;
    }
    y += rowH[r] + Math.max(chanH(r), r < rows.length - 1 ? 10 : 0);
  });
  const chanTop = (ch: number) => (ch < 0 ? 4 : rowTop[ch] + rowH[ch]);
  const slotY = (ch: number, s: number) => chanTop(ch) + 2 + 2 * s;

  // porte: uscite sul lato basso, entrate sul lato alto, ordinate per non incrociarsi
  const portX = (n: number, list: number[], ei: number) => {
    const b = boxes[n];
    const k = list.indexOf(ei);
    return b.x + Math.round((b.w * (k + 1)) / (list.length + 1));
  };
  const outs = d.nodes.map((_, n) => d.edges.map((_, i) => i).filter((i) => index.get(d.edges[i].from) === n));
  const ins = d.nodes.map((_, n) => d.edges.map((_, i) => i).filter((i) => index.get(d.edges[i].to) === n));
  const cx = (n: number) => boxes[n].x + boxes[n].w / 2;
  for (const n of d.nodes.keys()) {
    outs[n].sort((a, b) => cx(index.get(d.edges[a].to)!) - cx(index.get(d.edges[b].to)!));
    ins[n].sort((a, b) => cx(index.get(d.edges[a].from)!) - cx(index.get(d.edges[b].from)!));
  }

  let left = 0;
  let right = 0;
  const edges: EdgePath[] = d.edges.map((edge, i) => {
    const a = index.get(edge.from)!;
    const b = index.get(edge.to)!;
    const ox = portX(a, outs[a], i);
    const ix = portX(b, ins[b], i);
    const yo = slotY(rank[a], slotOf[i].out);
    const yi = slotY(rank[b] - 1, slotOf[i].in);
    const start: Pt = [ox, boxes[a].y + boxes[a].h];
    const end: Pt = [ix, boxes[b].y - 2];
    let pts: Pt[];
    if (kind[i] === "vicino") {
      pts = [start, [ox, yo], [ix, yo], end];
    } else {
      const lane = kind[i] === "salto" ? 3 + 2 * left++ : x0 + inner + 3 + 2 * right++;
      pts = [start, [ox, yo], [lane, yo], [lane, yi], [ix, yi], end];
    }
    return { edge, px: raster(pts), dir: "giu", label: edge.label ? { x: ix + 2, y: yi + 2 } : undefined };
  });

  return { w: x0 + inner + 4 + (rightLanes ? 2 * rightLanes + 3 : 0), h: y + 2, nodes: boxes, edges, lifelines: [] };
}

function layoutSequence(d: Diagram, scale: number): Layout {
  const boxes = measureNodes(d, scale);
  const index = new Map(d.nodes.map((n, i) => [n.id, i]));
  const labelW = (e: DiagramEdge) => (e.label ? Math.ceil(textWidth(e.label, EDGE_FONT) / scale) + 6 : 10);
  let step = Math.max(...boxes.map((b) => b.w)) + 8;
  for (const e of d.edges) {
    const span = Math.abs(index.get(e.to)! - index.get(e.from)!);
    if (span > 0) step = Math.max(step, Math.ceil(labelW(e) / span));
  }
  const first = Math.ceil(boxes[0].w / 2) + 4;
  const col = (n: number) => first + n * step;
  const headH = Math.max(...boxes.map((b) => b.h));
  boxes.forEach((b, n) => {
    b.x = col(n) - Math.floor(b.w / 2);
    b.y = 4 + headH - b.h;
  });
  const labelH = Math.ceil((EDGE_FONT + 4) / scale);
  const rowH = labelH + 6;
  const top = 4 + headH + 4;
  const edges: EdgePath[] = d.edges.map((edge, i) => {
    const a = col(index.get(edge.from)!);
    const b = col(index.get(edge.to)!);
    const y = top + labelH + 2 + i * rowH;
    if (a === b) {
      return {
        edge,
        px: raster([[a + 1, y - 2], [a + 9, y - 2], [a + 9, y + 2], [a + 3, y + 2]]),
        dir: "sinistra",
        label: edge.label ? { x: a + 12, y: y - labelH + 1 } : undefined,
      };
    }
    const dirSign = Math.sign(b - a);
    return {
      edge,
      px: raster([[a + dirSign, y], [b - 2 * dirSign, y]]),
      dir: dirSign > 0 ? "destra" : "sinistra",
      label: edge.label ? { x: (a + b) / 2, y: y - labelH, center: true } : undefined,
    };
  });
  const bottom = top + labelH + 2 + d.edges.length * rowH;
  const lastRight = Math.max(col(d.nodes.length - 1) + Math.ceil(boxes.at(-1)!.w / 2), ...edges.map((e) => (e.label && !e.label.center ? e.label.x + labelW(e.edge) : 0)));
  return {
    w: lastRight + 4,
    h: bottom + 2,
    nodes: boxes,
    edges,
    lifelines: d.nodes.map((_, n) => [col(n), 4 + headH, bottom]),
  };
}

// ---------- Disegno ----------

interface Palette {
  bg: string;
  grid: string;
  ink: string;
  dim: string;
  faint: string;
  lantern: string;
  deep: string;
  panel: string;
  panel2: string;
  sky: string;
  moss: string;
  plum: string;
}

function palette(): Palette {
  return {
    bg: css("--code-bg"),
    grid: css("--line"),
    ink: css("--ink"),
    dim: css("--ink-dim"),
    faint: css("--ink-faint"),
    lantern: css("--lantern"),
    deep: css("--lantern-deep"),
    panel: css("--panel"),
    panel2: css("--panel-2"),
    sky: css("--sky"),
    moss: css("--moss"),
    plum: css("--plum"),
  };
}

function drawNode(ctx: CanvasRenderingContext2D, b: NodeBox, p: Palette, outlineOnly: boolean): void {
  const px = (x: number, y: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, 1, 1);
  };
  const shape = b.node.shape ?? "stanza";
  const border = shape === "bivio" ? p.lantern : shape === "archivio" ? p.sky : shape === "attore" ? p.moss : p.ink;
  const fill = shape === "bivio" ? p.deep : p.panel2;
  // estensione orizzontale della forma a ogni riga: [inizio, fine] inclusi
  const span = (y: number): [number, number] | undefined => {
    if (shape === "bivio") {
      const mid = (b.h - 1) / 2;
      const inset = Math.round((Math.abs(y - mid) / mid) * 4);
      return [inset, b.w - 1 - inset];
    }
    if (shape === "archivio") {
      const cap = 3;
      const ry = y < cap ? cap - y - 0.5 : y > b.h - 1 - cap ? y - (b.h - 1 - cap) + 0.5 : 0;
      const half = (b.w / 2) * Math.sqrt(Math.max(0, 1 - (ry / (cap + 0.5)) ** 2));
      const a = Math.round(b.w / 2 - half);
      return [a, b.w - 1 - a];
    }
    // stanza e attore: rettangolo con angoli smussati di un pixel
    return y === 0 || y === b.h - 1 ? [1, b.w - 2] : [0, b.w - 1];
  };
  const spans = Array.from({ length: b.h }, (_, y) => span(y)!);
  for (let y = 0; y < b.h; y++) {
    const [a, z] = spans[y];
    const above = spans[y - 1];
    const below = spans[y + 1];
    for (let x = a; x <= z; x++) {
      const edge = x === a || x === z || !above || !below || x < above[0] || x > above[1] || x < below[0] || x > below[1];
      if (edge) px(b.x + x, b.y + y, border);
      else if (!outlineOnly) px(b.x + x, b.y + y, y === 1 ? p.panel : fill);
    }
  }
  if (outlineOnly) return;
  if (shape === "archivio") {
    // bordo inferiore del coperchio
    for (let x = 1; x < b.w - 1; x++) {
      const dy = Math.round(2 * Math.sqrt(Math.max(0, 1 - ((x - (b.w - 1) / 2) / (b.w / 2)) ** 2)));
      px(b.x + x, b.y + 3 + dy, border);
    }
  }
  if (shape === "attore") {
    const ix = b.x + 3;
    const iy = b.y + Math.floor(b.h / 2) - 4;
    for (const [x, y] of [[1, 0], [2, 0], [0, 1], [3, 1], [0, 2], [3, 2], [1, 3], [2, 3], [0, 5], [1, 4], [2, 4], [3, 5], [1, 5], [2, 5], [1, 6], [2, 6], [0, 7], [3, 7]]) {
      px(ix + x, iy + y, p.moss);
    }
  }
  if (b.node.code) {
    // gemma: questo nodo apre il codice
    const gx = b.x + b.w - 4;
    const gy = b.y + 2 + (shape === "archivio" ? 3 : 0);
    px(gx, gy, p.lantern);
    px(gx + 1, gy, p.lantern);
    px(gx, gy + 1, p.lantern);
    px(gx + 1, gy + 1, p.deep);
  }
}

function drawEdge(ctx: CanvasRenderingContext2D, e: EdgePath, amount: number, color: string): void {
  const n = Math.round(e.px.length * amount);
  const dashed = e.edge.style === "tratteggiato";
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    if (dashed && i % 4 >= 2) continue;
    ctx.fillRect(e.px[i][0], e.px[i][1], 1, 1);
  }
  if (amount < 1) return;
  const [x, y] = e.px.at(-1)!;
  // punta a pixel: 5 larga, 3 lunga
  for (let k = 0; k < 3; k++) {
    for (let j = -2 + k; j <= 2 - k; j++) {
      if (e.dir === "giu") ctx.fillRect(x + j, y + k, 1, 1);
      else if (e.dir === "destra") ctx.fillRect(x + k, y + j, 1, 1);
      else ctx.fillRect(x - k, y + j, 1, 1);
    }
  }
}

// ---------- Lavagna ----------

export interface BoardOptions {
  onOpenCode: (file: string, lines: [number, number]) => void;
  /** Scorre fino all'ultimo pezzo mostrato (finestra durante la spiegazione); altrimenti parte dall'alto. */
  follow?: boolean;
}

export class Board {
  readonly el: HTMLElement;
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private walker: HTMLCanvasElement;
  private summary: HTMLElement;
  private diagram: Diagram | undefined;
  private key = "";
  private layout: Layout | undefined;
  private scale = 3;
  private shown: Shown = { nodes: [], edges: [] };
  private nodeEls: HTMLElement[] = [];
  private edgeEls: (HTMLElement | undefined)[] = [];
  private run = 0;
  /** Pezzi mostrati, per riprendere il disegno da dove era arrivato. */
  pieces = 0;

  constructor(private opts: BoardOptions) {
    this.el = document.createElement("div");
    this.el.className = "board";
    this.stage = document.createElement("div");
    this.stage.className = "board-stage";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "board-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.walker = document.createElement("canvas");
    this.walker.className = "board-walker";
    this.walker.setAttribute("aria-hidden", "true");
    this.walker.hidden = true;
    this.summary = document.createElement("ul");
    this.summary.className = "sr-only";
    this.stage.append(this.canvas, this.walker);
    this.el.append(this.stage, this.summary);
  }

  get current(): Diagram | undefined {
    return this.diagram;
  }

  /** Mostra lo schema fino a `upto` pezzi; se è lo stesso schema, disegna solo i pezzi nuovi. */
  async show(d: Diagram, upto?: number, animate = true): Promise<void> {
    const run = ++this.run;
    const total = diagramPieces(d);
    const target = Math.min(total, upto ?? total);
    const key = JSON.stringify(d);
    await document.fonts.load(`${LABEL_FONT}px "Pixelify Sans"`).catch(() => undefined);
    if (run !== this.run) return;
    const scale = this.fitScale(d);
    // tornando indietro lo schema si accorcia senza animazione
    const shrinking = key === this.key && target < this.pieces;
    const previous = this.key;
    const rebuild = key !== this.key || scale !== this.scale || shrinking;
    if (rebuild) {
      this.diagram = d;
      this.key = key;
      this.scale = scale;
      this.layout = d.kind === "sequenza" ? layoutSequence(d, scale) : layoutFlow(d, scale);
      this.pieces = 0;
      this.build();
    }
    const from = this.pieces;
    this.pieces = target;
    this.renderSummary(target);
    if (!animate || shrinking || reducedMotion() || target === from) {
      this.reveal(target);
      this.draw();
      if (this.opts.follow) this.follow(target - 1, false);
      else if (rebuild && key !== previous) this.el.scrollTo({ top: 0 });
      return;
    }
    await this.animate(from, target, run);
  }

  /** Ridisegna con la scala adatta allo spazio attuale (es. dopo un cambio di contenitore). */
  refresh(): void {
    if (this.diagram) void this.show(this.diagram, this.pieces, false);
  }

  /** Scala più grande (3 o 2 pixel per pixel d'arte) con cui lo schema entra in larghezza. */
  private fitScale(d: Diagram): number {
    const avail = this.el.clientWidth - 8;
    if (avail <= 0) return window.matchMedia("(max-width: 760px)").matches ? 2 : 3;
    const l3 = d.kind === "sequenza" ? layoutSequence(d, 3) : layoutFlow(d, 3);
    return l3.w * 3 <= avail ? 3 : 2;
  }

  private build(): void {
    const l = this.layout!;
    const s = this.scale;
    this.canvas.width = l.w;
    this.canvas.height = l.h;
    this.stage.style.width = `${l.w * s}px`;
    this.stage.style.height = `${l.h * s}px`;
    this.stage.style.setProperty("--s", String(s));
    for (const el of [...this.nodeEls, ...this.edgeEls]) el?.remove();
    this.nodeEls = l.nodes.map((b) => {
      const code = b.node.code;
      const el = document.createElement(code ? "button" : "div");
      el.className = `board-node shape-${b.node.shape ?? "stanza"}`;
      el.style.left = `${b.x * s}px`;
      el.style.top = `${b.y * s}px`;
      el.style.width = `${b.w * s}px`;
      el.style.height = `${b.h * s}px`;
      el.textContent = b.lines.join("\n");
      if (code) {
        (el as HTMLButtonElement).type = "button";
        el.title = `Apri ${code.file}, righe ${code.lines[0]}-${code.lines[1]}`;
        el.setAttribute("aria-label", `${b.node.label}: apri ${code.file}, righe ${code.lines[0]}-${code.lines[1]}`);
        el.addEventListener("click", () => this.opts.onOpenCode(code.file, code.lines));
      } else {
        el.setAttribute("aria-hidden", "true");
      }
      this.stage.append(el);
      return el;
    });
    this.edgeEls = l.edges.map((e) => {
      if (!e.label || !e.edge.label) return undefined;
      const el = document.createElement("span");
      el.className = `board-edge${e.label.center ? " is-center" : ""}`;
      el.setAttribute("aria-hidden", "true");
      el.style.left = `${e.label.x * s}px`;
      el.style.top = `${e.label.y * s}px`;
      el.textContent = e.edge.label;
      this.stage.append(el);
      return el;
    });
    this.reveal(0);
  }

  /** Stato visibile con i primi n pezzi completi. */
  private reveal(n: number): void {
    const d = this.diagram!;
    if (d.kind === "sequenza") {
      this.shown = { nodes: d.nodes.map(() => true), edges: d.edges.map((_, i) => (i < n ? 1 : 0)) };
    } else {
      const idx = new Map(d.nodes.map((node, i) => [node.id, i]));
      this.shown = {
        nodes: d.nodes.map((_, i) => i < n),
        edges: d.edges.map((e) => (Math.max(idx.get(e.from)!, idx.get(e.to)!) < n ? 1 : 0)),
      };
    }
  }

  private async animate(from: number, to: number, run: number): Promise<void> {
    const d = this.diagram!;
    this.reveal(from);
    this.draw();
    const idx = new Map(d.nodes.map((node, i) => [node.id, i]));
    const ops: ({ node: number } | { edge: number })[] = [];
    for (let k = from; k < to; k++) {
      if (d.kind === "sequenza") {
        ops.push({ edge: k });
      } else {
        ops.push({ node: k });
        d.edges.forEach((e, i) => Math.max(idx.get(e.from)!, idx.get(e.to)!) === k && ops.push({ edge: i }));
      }
    }
    // tutto lo schema in circa 4 secondi al massimo
    const budget = Math.min(1, 4000 / (ops.length * 420));
    for (const op of ops) {
      if (run !== this.run) return;
      if ("node" in op) {
        this.follow(op.node, true);
        this.shown.nodes[op.node] = true;
        this.draw(op.node);
        await new Promise((r) => setTimeout(r, 90 * budget));
        this.draw();
        await new Promise((r) => setTimeout(r, 90 * budget));
      } else {
        const path = this.layout!.edges[op.edge].px;
        if (d.kind === "sequenza") this.follow(op.edge, true);
        const ms = Math.max(160, Math.min(650, path.length * 7)) * budget;
        const t0 = performance.now();
        this.walker.hidden = false;
        let f = 0;
        for (;;) {
          await frame();
          if (run !== this.run) return;
          const t = Math.min(1, (performance.now() - t0) / ms);
          this.shown.edges[op.edge] = t;
          this.draw(undefined, op.edge);
          const [x, y] = path[Math.min(path.length - 1, Math.round(t * (path.length - 1)))];
          this.moveWalker(x, y, ++f);
          if (t >= 1) break;
        }
      }
    }
    this.walker.hidden = true;
    this.draw();
  }

  /** Scorre la lavagna per mostrare il pezzo indicato (nodo in un flusso, messaggio in una sequenza). */
  private follow(piece: number, smooth: boolean): void {
    const l = this.layout!;
    if (piece < 0) return;
    let top: number;
    let bottom: number;
    if (this.diagram!.kind === "sequenza") {
      const e = l.edges[piece];
      if (!e) return;
      const y = e.px[0][1];
      top = y - 10;
      bottom = y + 6;
    } else {
      const b = l.nodes[piece];
      if (!b) return;
      top = b.y - 12;
      bottom = b.y + b.h + 4;
    }
    const s = this.scale;
    const box = this.el;
    const offset = this.stage.offsetTop;
    if (top * s + offset >= box.scrollTop && bottom * s + offset <= box.scrollTop + box.clientHeight) return;
    const want = Math.max(0, offset + ((top + bottom) / 2) * s - box.clientHeight / 2);
    box.scrollTo({ top: want, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  }

  private moveWalker(x: number, y: number, f: number): void {
    const size = 8 * this.scale;
    drawMiniLumen(this.walker, Math.floor(f / 6));
    this.walker.style.width = `${size}px`;
    this.walker.style.height = `${size}px`;
    this.walker.style.transform = `translate(${x * this.scale - size / 2}px, ${y * this.scale - size + 2}px)`;
  }

  /** Disegna lo stato visibile; `popping` è il nodo che sta comparendo, `tracing` l'arco che si sta tracciando. */
  private draw(popping?: number, tracing?: number): void {
    const l = this.layout!;
    const p = palette();
    const ctx = this.canvas.getContext("2d")!;
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, l.w, l.h);
    ctx.fillStyle = p.grid;
    for (let y = 3; y < l.h; y += 8) for (let x = 3; x < l.w; x += 8) ctx.fillRect(x, y, 1, 1);
    ctx.fillStyle = p.faint;
    for (const [x, y0, y1] of l.lifelines) for (let y = y0 + 1; y < y1; y++) if (y % 4 < 2) ctx.fillRect(x, y, 1, 1);
    l.edges.forEach((e, i) => {
      const amount = this.shown.edges[i];
      if (amount > 0) drawEdge(ctx, e, amount, i === tracing ? p.lantern : p.dim);
      const label = this.edgeEls[i];
      if (label) label.hidden = amount < 1;
    });
    l.nodes.forEach((b, i) => {
      if (this.shown.nodes[i]) drawNode(ctx, b, p, i === popping);
      this.nodeEls[i].hidden = !this.shown.nodes[i] || i === popping;
    });
  }

  private renderSummary(n: number): void {
    const d = this.diagram!;
    const nodes = d.kind === "sequenza" ? d.nodes : d.nodes.slice(0, n);
    const ids = new Set(nodes.map((x) => x.id));
    const label = new Map(d.nodes.map((x) => [x.id, x.label]));
    const edges = d.kind === "sequenza" ? d.edges.slice(0, n) : d.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    this.summary.replaceChildren(
      ...[
        `Schema «${d.title}» (${d.kind}): ${nodes.map((x) => x.label).join(", ")}.`,
        ...edges.map((e) => `${label.get(e.from)} → ${label.get(e.to)}${e.label ? ` (${e.label})` : ""}`),
      ].map((t) => {
        const li = document.createElement("li");
        li.textContent = t;
        return li;
      }),
    );
  }
}
