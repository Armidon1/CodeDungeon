// Lumen, la guida: uno spiritello-lanterna disegnato pixel per pixel su una griglia 32×32.
// Il ritratto ha cinque espressioni, sbatte le palpebre, muove la bocca mentre parla e fluttua.

import type { Expression } from "../shared/types";

const C = {
  outline: "#7a4a1f",
  body: "#f7cf72",
  shade: "#e2a94c",
  light: "#fff2c4",
  eye: "#3a2a1c",
  blush: "#f19a86",
  leaf: "#7fc58f",
  leafDark: "#4f9a66",
  stem: "#6b8f4a",
  sweat: "#9fd4f2",
  think: "#efe6d2",
  spark: "#ffe9a8",
};

type Px = (x: number, y: number, color: string) => void;

export interface PortraitState {
  expression: Expression;
  talking: boolean;
}

/** Disegna Lumen su una griglia 32×32 (coordinate in "pixel di gioco"). */
function drawLumen(px: Px, expr: Expression, frame: { blink: boolean; mouthOpen: boolean; t: number }): void {
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

  const eyes = (lx: number, rx: number, y: number, w: number, h: number) => {
    if (frame.blink) {
      for (let i = 0; i < w; i++) {
        px(lx + i, y + h - 1, C.eye);
        px(rx + i, y + h - 1, C.eye);
      }
      return;
    }
    for (let i = 0; i < w; i++)
      for (let j = 0; j < h; j++) {
        px(lx + i, y + j, C.eye);
        px(rx + i, y + j, C.eye);
      }
    // scintilla nell'occhio
    px(lx, y, C.light);
    px(rx, y, C.light);
  };
  const blush = () => {
    for (const x of [9, 10, 21, 22]) px(x, 21, C.blush);
  };

  switch (expr) {
    case "felice": {
      // occhi a mezzaluna ^ ^
      for (const ox of [10, 19]) {
        px(ox, 18, C.eye);
        px(ox + 1, 17, C.eye);
        px(ox + 2, 17, C.eye);
        px(ox + 3, 18, C.eye);
      }
      blush();
      // sorriso aperto
      for (const [x, y] of [[14, 21], [18, 21], [15, 22], [16, 22], [17, 22]]) px(x, y, C.eye);
      if (frame.mouthOpen) for (const [x, y] of [[15, 21], [16, 21], [17, 21]]) px(x, y, C.blush);
      break;
    }
    case "pensieroso": {
      // occhi che guardano in alto a destra
      eyes(12, 19, 15, 2, 2);
      if (!frame.blink) {
        px(12, 15, C.eye);
        px(19, 15, C.eye);
        px(13, 15, C.light);
        px(20, 15, C.light);
      }
      for (const x of [17, 18, 19]) px(x, 22, C.eye);
      if (frame.mouthOpen) px(18, 23, C.eye);
      // nuvoletta del pensiero
      const pulse = Math.floor(frame.t / 400) % 3;
      px(25, 9, C.think);
      if (pulse > 0) for (const [x, y] of [[27, 6], [28, 6], [27, 7], [28, 7]]) px(x, y, C.think);
      if (pulse > 1) for (let x = 28; x < 32; x++) for (let y = 1; y < 4; y++) px(x, y, C.think);
      break;
    }
    case "preoccupato": {
      // sopracciglia inclinate
      for (const [x, y] of [[10, 14], [11, 14], [12, 15], [21, 14], [22, 14], [20, 15]]) px(x, y, C.eye);
      eyes(11, 20, 17, 2, 3);
      // bocca ondulata
      for (const [x, y] of [[13, 23], [14, 22], [15, 23], [16, 22], [17, 23], [18, 22], [19, 23]]) px(x, y, C.eye);
      // goccia di sudore
      const drip = Math.floor(frame.t / 500) % 2;
      for (const [x, y] of [[25, 12], [24, 13], [25, 13], [26, 13], [24, 14], [25, 14], [26, 14], [25, 15]]) px(x, y + drip, C.sweat);
      px(24, 13 + drip, "#ffffff");
      break;
    }
    case "sorpreso": {
      eyes(10, 19, 16, 3, 3);
      // bocca a O
      for (const [x, y] of [[15, 21], [16, 21], [14, 22], [17, 22], [14, 23], [17, 23], [15, 24], [16, 24]]) px(x, y, C.eye);
      break;
    }
    default: {
      eyes(11, 20, 17, 2, 3);
      if (frame.mouthOpen) for (const [x, y] of [[15, 22], [16, 22], [15, 23], [16, 23]]) px(x, y, C.eye);
      else for (const x of [15, 16]) px(x, 22, C.eye);
      blush();
    }
  }
}

/** Ritratto animato su canvas. */
export class Portrait {
  private ctx: CanvasRenderingContext2D;
  private state: PortraitState = { expression: "neutro", talking: false };
  private nextBlink = 0;
  private blinkUntil = 0;
  private raf = 0;
  private reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(private canvas: HTMLCanvasElement) {
    canvas.width = 32;
    canvas.height = 32;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
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
    const time = this.reduced ? 0 : t;
    if (!this.reduced) {
      if (t > this.nextBlink) {
        this.blinkUntil = t + 130;
        this.nextBlink = t + 2500 + Math.random() * 3000;
      }
    }
    const bob = this.reduced ? 0 : Math.sin(t / 520) > 0 ? 0 : 1;
    const mouthOpen = this.state.talking && !this.reduced && Math.floor(t / 110) % 2 === 0;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, 32, 32);
    const px: Px = (x, y, color) => {
      const yy = y + bob;
      if (x < 0 || x > 31 || yy < 0 || yy > 31) return;
      ctx.fillStyle = color;
      ctx.fillRect(x, yy, 1, 1);
    };
    drawLumen(px, this.state.expression, { blink: t < this.blinkUntil, mouthOpen, t: time });
  }
}

/** Versione mini (16×16) che cammina nell'esplora file. */
export function drawMiniLumen(canvas: HTMLCanvasElement, step: number): void {
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 16, 16);
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
