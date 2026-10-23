// Le guide. Quattro ritratti predefiniti disegnati pixel per pixel su una griglia 32×32
// (Lumen, lo spiritello-lanterna, e tre alternative) oppure un'immagine dell'utente già in pixel art.
// Ogni guida ha cinque espressioni, fluttua e parla; i ritratti predefiniti sbattono anche le palpebre.

import type { Expression } from "../shared/types";
import { reducedMotion } from "./reader";

export const BUILTIN_GUIDES = ["lumen", "aria", "patrizio", "nilo"] as const;
export type BuiltinGuide = (typeof BUILTIN_GUIDES)[number];

export const GUIDE_INFO: Record<BuiltinGuide, { name: string; hint: string }> = {
  lumen: { name: "Lumen", hint: "Lanterna, predefinita" },
  aria: { name: "Aria", hint: "Femminile" },
  patrizio: { name: "Patrizio", hint: "Maschile" },
  nilo: { name: "Nilo", hint: "Neutro" },
};

/** Guida dell'utente: immagini già in pixel art, una per espressione; le mancanti si generano dalla base. */
export interface CustomImage {
  base: HTMLCanvasElement;
  faces: Partial<Record<Expression, HTMLCanvasElement>>;
  /** Sfondo trasparente: la figura può fluttuare senza lasciare buchi. */
  cutout: boolean;
}

export type GuideLook = { kind: "builtin"; id: BuiltinGuide } | { kind: "custom"; image: CustomImage };

type Px = (x: number, y: number, color: string) => void;
interface Frame {
  blink: boolean;
  mouthOpen: boolean;
  t: number;
}

/** Colori del viso, comuni a tutti i ritratti disegnati. */
interface FacePal {
  outline: string;
  body: string;
  shade: string;
  light: string;
  eye: string;
  blush: string;
  sweat: string;
  shine: string;
  think: string;
}

const LUMEN = {
  outline: "#7a4a1f",
  body: "#f7cf72",
  shade: "#e2a94c",
  light: "#fff2c4",
  eye: "#3a2a1c",
  blush: "#f19a86",
  sweat: "#9fd4f2",
  shine: "#ffffff",
  think: "#efe6d2",
  leaf: "#7fc58f",
  leafDark: "#4f9a66",
  stem: "#6b8f4a",
};

// ---------- Viso ed espressioni ----------

/** Occhi, bocca ed effetti dell'espressione. Le coordinate valgono per tutti i ritratti 32×32. */
function drawFace(px: Px, expr: Expression, frame: Frame, c: FacePal): void {
  const eyes = (lx: number, rx: number, y: number, w: number, h: number) => {
    if (frame.blink) {
      for (let i = 0; i < w; i++) {
        px(lx + i, y + h - 1, c.eye);
        px(rx + i, y + h - 1, c.eye);
      }
      return;
    }
    for (let i = 0; i < w; i++)
      for (let j = 0; j < h; j++) {
        px(lx + i, y + j, c.eye);
        px(rx + i, y + j, c.eye);
      }
    // scintilla nell'occhio
    px(lx, y, c.light);
    px(rx, y, c.light);
  };
  const blush = () => {
    for (const x of [9, 10, 21, 22]) px(x, 21, c.blush);
  };

  switch (expr) {
    case "felice": {
      // occhi a mezzaluna ^ ^
      for (const ox of [10, 19]) {
        px(ox, 18, c.eye);
        px(ox + 1, 17, c.eye);
        px(ox + 2, 17, c.eye);
        px(ox + 3, 18, c.eye);
      }
      blush();
      // sorriso aperto
      for (const [x, y] of [[14, 21], [18, 21], [15, 22], [16, 22], [17, 22]]) px(x, y, c.eye);
      if (frame.mouthOpen) for (const [x, y] of [[15, 21], [16, 21], [17, 21]]) px(x, y, c.blush);
      break;
    }
    case "pensieroso": {
      // occhi che guardano in alto a destra
      eyes(12, 19, 15, 2, 2);
      if (!frame.blink) {
        px(12, 15, c.eye);
        px(19, 15, c.eye);
        px(13, 15, c.light);
        px(20, 15, c.light);
      }
      for (const x of [17, 18, 19]) px(x, 22, c.eye);
      if (frame.mouthOpen) px(18, 23, c.eye);
      // nuvoletta del pensiero
      const pulse = Math.floor(frame.t / 400) % 3;
      px(25, 9, c.think);
      if (pulse > 0) for (const [x, y] of [[27, 6], [28, 6], [27, 7], [28, 7]]) px(x, y, c.think);
      if (pulse > 1) for (let x = 28; x < 32; x++) for (let y = 1; y < 4; y++) px(x, y, c.think);
      break;
    }
    case "preoccupato": {
      // sopracciglia inclinate
      for (const [x, y] of [[10, 14], [11, 14], [12, 15], [21, 14], [22, 14], [20, 15]]) px(x, y, c.eye);
      eyes(11, 20, 17, 2, 3);
      // bocca ondulata
      for (const [x, y] of [[13, 23], [14, 22], [15, 23], [16, 22], [17, 23], [18, 22], [19, 23]]) px(x, y, c.eye);
      // goccia di sudore
      const drip = Math.floor(frame.t / 500) % 2;
      for (const [x, y] of [[25, 12], [24, 13], [25, 13], [26, 13], [24, 14], [25, 14], [26, 14], [25, 15]]) px(x, y + drip, c.sweat);
      px(24, 13 + drip, c.shine);
      break;
    }
    case "sorpreso": {
      eyes(10, 19, 16, 3, 3);
      // bocca a O
      for (const [x, y] of [[15, 21], [16, 21], [14, 22], [17, 22], [14, 23], [17, 23], [15, 24], [16, 24]]) px(x, y, c.eye);
      break;
    }
    default: {
      eyes(11, 20, 17, 2, 3);
      if (frame.mouthOpen) for (const [x, y] of [[15, 22], [16, 22], [15, 23], [16, 23]]) px(x, y, c.eye);
      else for (const x of [15, 16]) px(x, 22, c.eye);
      blush();
    }
  }
}

// ---------- Lumen ----------

function drawLumen(px: Px, expr: Expression, frame: Frame): void {
  const C = LUMEN;
  const cx = 16;
  const cy = 18;
  const r = 10.2;

  // corpo: cerchio con contorno, ombra in basso a destra e riflesso in alto a sinistra
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (d > r - 1.15) px(x, y, C.outline);
      else if (dx + dy > 7.5) px(x, y, C.shade);
      else px(x, y, C.body);
    }
  }
  for (const [x, y] of [[10, 11], [11, 11], [9, 12], [10, 12], [9, 13]]) px(x, y, C.light);

  // germoglio in testa (oscilla leggermente)
  const sway = Math.sin(frame.t / 600) > 0.3 ? 1 : 0;
  px(16, 8, C.stem);
  px(16, 7, C.stem);
  for (const [x, y] of [[13, 5], [14, 5], [14, 6], [15, 6]]) px(x + sway, y, C.leaf);
  for (const [x, y] of [[17, 4], [18, 4], [19, 4], [17, 5], [18, 5]]) px(x + sway, y, C.leaf);
  px(13 + sway, 6, C.leafDark);
  px(19 + sway, 5, C.leafDark);

  drawFace(px, expr, frame, C);
}

// ---------- Aria, Patrizio, Nilo: busti con capelli e vestiti ----------

type Inside = (x: number, y: number) => boolean;

const ellipse = (cx: number, cy: number, rx: number, ry: number): Inside => (x, y) =>
  ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;

/** Riempie una forma; i pixel con un vicino fuori dalla forma diventano contorno. */
function shape(px: Px, inside: Inside, fill: (x: number, y: number) => string, outline: string): void {
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      if (!inside(x, y)) continue;
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      px(x, y, edge ? outline : fill(x, y));
    }
}

interface HumanPal extends FacePal {
  hair: string;
  hairDark: string;
  hairLight: string;
  cloth: string;
  clothDark: string;
}

interface Human {
  pal: HumanPal;
  /** Capelli dietro la testa (lunghi). */
  back?: Inside;
  /** Capelli o cappello davanti: frangia, ciuffi. */
  front: Inside;
  /** Dietro la testa ma sopra i capelli lunghi: orecchie. */
  under?: (px: Px) => void;
  /** Vestito con un motivo; altrimenti tinta unita con l'ombra. */
  cloth?: (x: number, y: number) => string;
  /** Dettagli sotto il viso e le sue espressioni: fiore, pon pon, sciarpa, barba. */
  extras?: (px: Px, frame: Frame, expr: Expression) => void;
}

const head = ellipse(16, 17.5, 8.6, 9.3);
const cap = ellipse(16, 16.5, 9.6, 9.8);

function drawHuman(px: Px, h: Human, expr: Expression, frame: Frame): void {
  const p = h.pal;
  const hairFill = (x: number, y: number) => ((x * 7 + y * 3) % 11 === 0 ? p.hairLight : x + y > 36 ? p.hairDark : p.hair);
  // spalle: la riga sotto il ritratto è "dentro", così il busto non ha contorno in fondo
  shape(px, (x, y) => y >= 27 && y <= 33 && Math.abs(x + 0.5 - 16) <= 6 + (y - 27) * 1.6, h.cloth ?? ((x, y) => (x + y > 42 ? p.clothDark : p.cloth)), p.outline);
  if (h.back) shape(px, h.back, hairFill, p.outline);
  h.under?.(px);
  for (let y = 25; y <= 27; y++) for (let x = 14; x <= 17; x++) px(x, y, p.shade);
  shape(px, head, (x, y) => (x - 16 + (y - 17.5) > 9 ? p.shade : p.body), p.outline);
  shape(px, h.front, hairFill, p.outline);
  h.extras?.(px, frame, expr);
  drawFace(px, expr, frame, p);
}

const ARIA: Human = {
  pal: {
    outline: "#4b2a25",
    body: "#f8d4b4",
    shade: "#e6ad8e",
    light: "#fff2c4",
    eye: "#3a2a1c",
    blush: "#f19a86",
    sweat: "#9fd4f2",
    shine: "#ffffff",
    think: "#efe6d2",
    hair: "#b5553c",
    hairDark: "#7d3324",
    hairLight: "#de7a52",
    cloth: "#7fc58f",
    clothDark: "#4f9a66",
  },
  // capelli lunghi fino alle spalle
  back: (x, y) => (ellipse(16, 15.5, 11, 11)(x, y) || ellipse(16, 22, 10.4, 9.5)(x, y)) && !(y >= 24 && Math.abs(x + 0.5 - 16) < 6),
  // frangia di lato, più lunga a sinistra
  front: (x, y) => cap(x, y) && y < 14 - (x - 8) * 0.25,
  extras: (px) => {
    // fiore tra i capelli
    for (const [x, y] of [[21, 9], [23, 9], [22, 8], [22, 10]]) px(x, y, "#c9a0e8");
    px(22, 9, "#f5c25c");
  },
};

const PATRIZIO: Human = {
  pal: {
    outline: "#2e1d16",
    body: "#efc8a4",
    shade: "#d6a47e",
    light: "#fff2c4",
    eye: "#2a1c15",
    blush: "#e8977f",
    sweat: "#9fd4f2",
    shine: "#ffffff",
    think: "#efe6d2",
    hair: "#4a3326",
    hairDark: "#2f2019",
    hairLight: "#6b4a36",
    cloth: "#3d4f7c",
    clothDark: "#2b3858",
  },
  // capelli corti con volume sopra la fronte, tempie un po' scoperte e basette corte
  front: (x, y) => {
    const d = Math.abs(x + 0.5 - 16);
    const hairline = d < 4 ? 11 : d < 6 ? 10 : d < 7.5 ? 11 : 15;
    return ellipse(16, 13.5, 9.4, 8)(x, y) && y < hairline;
  },
  // orecchie a sventola
  under: (px) => {
    for (const ox of [6.6, 25.4]) shape(px, ellipse(ox, 18.5, 2.2, 3), () => "#d6a47e", "#2e1d16");
  },
  // camicia a quadri con il colletto chiaro
  cloth: (x, y) => (x % 4 === 1 || y % 4 === 2 ? (x % 4 === 1 && y % 4 === 2 ? "#e8dccb" : "#7d95c4") : x + y > 42 ? "#2b3858" : "#3d4f7c"),
  extras: (px, _frame, expr) => {
    for (const [x, y] of [[12, 27], [13, 27], [13, 28], [19, 27], [18, 27], [18, 28]]) px(x, y, "#e8dccb");
    // sopracciglia folte: si alzano con la sorpresa e i pensieri (preoccupato ha le sue)
    if (expr !== "preoccupato") {
      const y = expr === "sorpreso" || expr === "pensieroso" ? 13 : 15;
      for (const x of [10, 11, 12, 13, 19, 20, 21, 22]) px(x, y, "#2f2019");
      for (const x of [11, 12, 20, 21]) px(x, y - 1, "#2f2019");
    }
    // baffi e pizzetto
    for (const x of [13, 14, 15, 16, 17, 18]) px(x, 20, "#6b4a36");
    for (const [x, y] of [[15, 24], [16, 24], [14, 25], [15, 25], [16, 25], [17, 25]]) px(x, y, "#4a3326");
  },
};

const NILO: Human = {
  pal: {
    outline: "#3a241a",
    body: "#b47b52",
    shade: "#94603c",
    light: "#fff2c4",
    eye: "#2a1c15",
    blush: "#de7f6a",
    sweat: "#9fd4f2",
    shine: "#ffffff",
    think: "#efe6d2",
    hair: "#5f8fbf",
    hairDark: "#44709e",
    hairLight: "#8cc3e6",
    cloth: "#c9a0e8",
    clothDark: "#9a74bf",
  },
  // berretto di lana che copre la fronte
  front: (x, y) => ellipse(16, 15.5, 9.8, 9.6)(x, y) && y <= 12,
  extras: (px) => {
    // risvolto del berretto, ciuffi, pon pon e sciarpa
    for (let x = 8; x <= 24; x++) if (ellipse(16, 15.5, 9.8, 9.6)(x, 12)) px(x, 12, "#efe6d2");
    for (const [x, y] of [[8, 13], [8, 14], [9, 13], [23, 13], [24, 13], [24, 14]]) px(x, y, "#2b2438");
    shape(px, ellipse(16, 5.5, 2.8, 2.8), () => "#ee8a6d", "#3a241a");
    shape(px, (x, y) => y >= 25 && y <= 28 && x >= 10 && x <= 22 && !(y === 25 && (x < 12 || x > 20)), (x) => (x % 4 === 0 ? "#f5c25c" : "#ee8a6d"), "#3a241a");
  },
};

const HUMANS: Record<Exclude<BuiltinGuide, "lumen">, Human> = { aria: ARIA, patrizio: PATRIZIO, nilo: NILO };

// ---------- Immagine dell'utente ----------

const EMOTE_INK: Record<string, string> = { o: "#17142a", d: "#3a2a1c", h: "#ffffff" };

/** Fumetti delle espressioni automatiche (stile "emote" dei giochi di ruolo): `w` è il colore di riempimento. */
const EMOTES: Record<Exclude<Expression, "neutro">, { fill: string; frames: string[][] }> = {
  felice: {
    fill: "#ffe9a8",
    frames: [
      ["..o....", ".owo...", "owwwo..", ".owo...", "..o..o.", "....owo", ".....o."],
      ["....o..", "...owo.", "..owwwo", "...owo.", ".o..o..", "owo....", ".o....."],
    ],
  },
  pensieroso: {
    fill: "#efe6d2",
    frames: [
      [".ooooooo.", "owwwwwwwo", "owwwwwwwo", "owwwwwwwo", ".ooooooo.", "..oo.....", "..o......"],
      [".ooooooo.", "owwwwwwwo", "owdwwwwwo", "owwwwwwwo", ".ooooooo.", "..oo.....", "..o......"],
      [".ooooooo.", "owwwwwwwo", "owdwdwwwo", "owwwwwwwo", ".ooooooo.", "..oo.....", "..o......"],
      [".ooooooo.", "owwwwwwwo", "owdwdwdwo", "owwwwwwwo", ".ooooooo.", "..oo.....", "..o......"],
    ],
  },
  preoccupato: {
    fill: "#9fd4f2",
    frames: [["..o..", ".owo.", "owwwo", "ohwwo", "owwwo", ".ooo."]],
  },
  sorpreso: {
    fill: "#f5c25c",
    frames: [[".ooo.", "owwwo", "owwwo", ".owo.", ".owo.", "..o..", ".ooo.", ".owo.", ".ooo."]],
  },
};

const tintCache = new WeakMap<HTMLCanvasElement, Map<Expression, HTMLCanvasElement>>();

/** La base ritoccata per un'espressione automatica: più calda se felice, più fredda se preoccupata. */
function tinted(base: HTMLCanvasElement, expr: Expression): HTMLCanvasElement {
  if (expr === "neutro" || expr === "pensieroso") return base;
  let cache = tintCache.get(base);
  if (!cache) tintCache.set(base, (cache = new Map()));
  const hit = cache.get(expr);
  if (hit) return hit;
  const out = document.createElement("canvas");
  out.width = base.width;
  out.height = base.height;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(base, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    if (expr === "felice") {
      d[i] = r * 1.06 + 10;
      d[i + 1] = g * 1.03 + 5;
      d[i + 2] = b * 0.96;
    } else if (expr === "preoccupato") {
      const grey = 0.3 * r + 0.59 * g + 0.11 * b;
      d[i] = r * 0.6 + grey * 0.3;
      d[i + 1] = g * 0.6 + grey * 0.35;
      d[i + 2] = b * 0.6 + grey * 0.35 + 20;
    } else {
      d[i] = r * 1.05 + 6;
      d[i + 1] = g * 1.05 + 6;
      d[i + 2] = b * 1.05 + 6;
    }
  }
  ctx.putImageData(img, 0, 0);
  cache.set(expr, out);
  return out;
}

function drawCustom(ctx: CanvasRenderingContext2D, image: CustomImage, expr: Expression, t: number, lift: number): void {
  const n = image.base.width;
  const u = Math.max(1, Math.round(n / 24));
  const own = image.faces[expr];
  const src = own ?? tinted(image.base, expr);
  // un'espressione caricata con un altro dettaglio viene adattata al lato della base
  ctx.drawImage(src, 0, 0, src.width, src.height, 0, lift * u, n, n);
  if (own || expr === "neutro") return;
  const emote = EMOTES[expr];
  const rows = emote.frames[Math.floor(t / 420) % emote.frames.length];
  const hop = expr === "sorpreso" || expr === "preoccupato" ? Math.floor(t / 300) % 2 : 0;
  const ox = n - rows[0].length * u - u;
  const oy = u + hop * u;
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      ctx.fillStyle = ch === "w" ? emote.fill : EMOTE_INK[ch];
      ctx.fillRect(ox + x * u, oy + y * u, u, u);
    }),
  );
}

// ---------- Disegno comune ----------

/** Lato in pixel di gioco del ritratto. */
export const lookSize = (look: GuideLook): number => (look.kind === "custom" ? look.image.base.width : 32);

interface DrawState {
  expression: Expression;
  blink: boolean;
  mouthOpen: boolean;
  /** Tempo per le animazioni; 0 con movimento ridotto. */
  t: number;
  /** Spostamento verticale (fluttuare, parlare) in pixel di gioco. */
  lift: number;
}

function drawLook(ctx: CanvasRenderingContext2D, look: GuideLook, s: DrawState): void {
  const n = lookSize(look);
  ctx.clearRect(0, 0, n, n);
  if (look.kind === "custom") {
    drawCustom(ctx, look.image, s.expression, s.t, look.image.cutout ? s.lift : 0);
    return;
  }
  const px: Px = (x, y, color) => {
    const yy = y + s.lift;
    if (x < 0 || x > 31 || yy < 0 || yy > 31) return;
    ctx.fillStyle = color;
    ctx.fillRect(x, yy, 1, 1);
  };
  const frame = { blink: s.blink, mouthOpen: s.mouthOpen, t: s.t };
  if (look.id === "lumen") drawLumen(px, s.expression, frame);
  else drawHuman(px, HUMANS[look.id], s.expression, frame);
}

function fit(canvas: HTMLCanvasElement, n: number): CanvasRenderingContext2D {
  if (canvas.width !== n || canvas.height !== n) {
    canvas.width = n;
    canvas.height = n;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Un fotogramma fermo, per le anteprime. */
export function drawStill(canvas: HTMLCanvasElement, look: GuideLook, expression: Expression = "neutro"): void {
  drawLook(fit(canvas, lookSize(look)), look, { expression, blink: false, mouthOpen: false, t: 0, lift: 0 });
}

// ---------- Guida scelta dall'utente ----------

let current: GuideLook = { kind: "builtin", id: "lumen" };
let miniCache: { look: GuideLook; canvas: HTMLCanvasElement } | undefined;

export function setGuideLook(look: GuideLook): void {
  current = look;
}

export function guideLook(): GuideLook {
  return current;
}

export interface PortraitState {
  expression: Expression;
  talking: boolean;
}

/** Ritratto animato su canvas: mostra la guida scelta, oppure `look` se indicato (anteprime). */
export class Portrait {
  private state: PortraitState = { expression: "neutro", talking: false };
  private nextBlink = 0;
  private blinkUntil = 0;
  private raf = 0;
  private reduced = reducedMotion();

  constructor(
    private canvas: HTMLCanvasElement,
    private look?: GuideLook,
  ) {
    const loop = (t: number) => {
      this.render(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  set(partial: Partial<PortraitState>): void {
    this.state = { ...this.state, ...partial };
  }

  get expression(): Expression {
    return this.state.expression;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  private render(t: number): void {
    const look = this.look ?? current;
    // si rilegge a ogni fotogramma: "meno animazioni" si può attivare con il gioco aperto
    this.reduced = reducedMotion();
    if (!this.reduced && t > this.nextBlink) {
      this.blinkUntil = t + 130;
      this.nextBlink = t + 2500 + Math.random() * 3000;
    }
    const talking = this.state.talking && !this.reduced;
    const bob = this.reduced ? 0 : Math.sin(t / 520) > 0 ? 0 : 1;
    const mouthOpen = talking && Math.floor(t / 110) % 2 === 0;
    // le immagini dell'utente non hanno una bocca da muovere: mentre parla la figura saltella
    const lift = look.kind === "custom" && talking ? bob + (mouthOpen ? 0 : 1) : bob;
    drawLook(fit(this.canvas, lookSize(look)), look, {
      expression: this.state.expression,
      blink: !this.reduced && t < this.blinkUntil,
      mouthOpen,
      t: this.reduced ? 0 : t,
      lift,
    });
  }
}

/** La mini-guida 16×16 che cammina nell'esplora file e sulla lavagna. */
export function drawMiniGuide(canvas: HTMLCanvasElement, step: number): void {
  const ctx = fit(canvas, 16);
  ctx.clearRect(0, 0, 16, 16);
  if (current.kind === "builtin" && current.id === "lumen") {
    drawMiniLumen(ctx, step);
    return;
  }
  if (miniCache?.look !== current) miniCache = { look: current, canvas: shrink(current) };
  const lift = step % 2;
  ctx.drawImage(miniCache.canvas, 1, 1 - lift);
  // piedini che si alternano
  ctx.fillStyle = "#17142a";
  ctx.fillRect(step % 2 ? 5 : 4, 15, 2, 1);
  ctx.fillRect(step % 2 ? 10 : 11, 15, 2, 1);
}

/** Riduce il ritratto a 14×14 tenendo in ogni blocco il colore più frequente: i dettagli restano netti. */
function shrink(look: GuideLook): HTMLCanvasElement {
  const big = document.createElement("canvas");
  drawStill(big, look);
  const n = big.width;
  const src = big.getContext("2d")!.getImageData(0, 0, n, n).data;
  const out = document.createElement("canvas");
  const ctx = fit(out, 14);
  for (let j = 0; j < 14; j++)
    for (let i = 0; i < 14; i++) {
      const counts = new Map<number, number>();
      let opaque = 0;
      let cells = 0;
      for (let y = Math.floor((j * n) / 14); y < Math.floor(((j + 1) * n) / 14); y++)
        for (let x = Math.floor((i * n) / 14); x < Math.floor(((i + 1) * n) / 14); x++) {
          const k = (y * n + x) * 4;
          cells++;
          if (src[k + 3] < 128) continue;
          opaque++;
          const rgb = (src[k] << 16) | (src[k + 1] << 8) | src[k + 2];
          counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
        }
      if (opaque * 2 < cells) continue;
      let best = 0;
      let bestN = -1;
      for (const [rgb, c] of counts) if (c > bestN) [best, bestN] = [rgb, c];
      ctx.fillStyle = `rgb(${best >> 16} ${(best >> 8) & 255} ${best & 255})`;
      ctx.fillRect(i, j, 1, 1);
    }
  return out;
}

function drawMiniLumen(ctx: CanvasRenderingContext2D, step: number): void {
  const C = LUMEN;
  const px = (x: number, y: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, 1, 1);
  };
  const lift = step % 2;
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8 + lift);
      if (d > 5.3) continue;
      px(x, y, d > 4.3 ? C.outline : x + y > 18 ? C.shade : C.body);
    }
  px(8, 2 - lift, C.stem);
  px(7, 1 - lift, C.leaf);
  px(9, 1 - lift, C.leaf);
  px(6, 7 - lift, C.eye);
  px(10, 7 - lift, C.eye);
  px(6, 8 - lift, C.eye);
  px(10, 8 - lift, C.eye);
  // piedini che si alternano
  px(step % 2 ? 6 : 5, 14, C.outline);
  px(step % 2 ? 10 : 11, 14, C.outline);
}
