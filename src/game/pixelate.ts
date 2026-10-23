// Da foto o disegno a pixel art: ritaglio quadrato, riduzione per gradi, pochi colori (k-means)
// e contorno scuro se lo sfondo è trasparente. Tutto avviene nel browser: l'immagine non esce dal computer.

import { t } from "./i18n";

/** Dettaglio regolabile con lo slider: lato del ritratto in pixel di gioco. */
export const DETAIL = { min: 16, max: 64, step: 2 } as const;

/** Colori della palette per un certo dettaglio: meno pixel, meno colori. */
export const colorsFor = (size: number): number => Math.round(size / 2.5);

/** I tre livelli di compressione mostrati affiancati (nomi in i18n.ts). */
export const PRESETS = [{ size: 48 }, { size: 32 }, { size: 20 }] as const;

const MAX_BYTES = 20 * 1024 * 1024;

export async function readImage(file: File): Promise<ImageBitmap> {
  if (!file.type.startsWith("image/")) throw new Error(t().msg.notImage);
  if (file.size > MAX_BYTES) throw new Error(t().msg.tooBig);
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(t().msg.unreadable);
  }
}

function canvas(w: number, h = w): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Converte l'immagine in un ritratto `size`×`size` con `colorsFor(size)` colori. */
export function pixelate(src: ImageBitmap, size: number): HTMLCanvasElement {
  // ritaglio quadrato: nelle foto verticali il viso sta di solito in alto
  const side = Math.min(src.width, src.height);
  const sx = (src.width - side) / 2;
  const sy = src.height > src.width ? (src.height - side) * 0.2 : 0;

  // riduzione per metà successive: la media dei pixel resta pulita anche da foto grandi
  let step = canvas(Math.min(side, size * 8));
  let ctx = step.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, side, side, 0, 0, step.width, step.height);
  while (step.width / 2 >= size * 2) {
    const half = canvas(Math.floor(step.width / 2));
    ctx = half.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(step, 0, 0, half.width, half.height);
    step = half;
  }
  const out = canvas(size);
  ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(step, 0, 0, size, size);

  const img = ctx.getImageData(0, 0, size, size);
  quantize(img.data, colorsFor(size));
  outline(img.data, size);
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Distanza tra colori pesata sulla sensibilità dell'occhio (più al verde, meno al blu). */
const dist = (a: number[], r: number, g: number, b: number) => 2 * (a[0] - r) ** 2 + 4 * (a[1] - g) ** 2 + 3 * (a[2] - b) ** 2;

/** Riduce i colori a `k` con k-means; i pixel semitrasparenti diventano pieni o vuoti. */
function quantize(d: Uint8ClampedArray, k: number): void {
  const opaque: number[] = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) d[i + 3] = 0;
    else {
      d[i + 3] = 255;
      opaque.push(i);
    }
  }
  if (opaque.length === 0) return;

  // centri iniziali: il colore medio, poi ogni volta il pixel più lontano dai centri già scelti
  const mean = [0, 0, 0];
  for (const i of opaque) for (let c = 0; c < 3; c++) mean[c] += d[i + c] / opaque.length;
  const centers = [mean];
  const near = opaque.map((i) => dist(mean, d[i], d[i + 1], d[i + 2]));
  while (centers.length < k) {
    let far = -1;
    let farD = 0;
    near.forEach((v, j) => {
      if (v > farD) [far, farD] = [j, v];
    });
    if (far < 0) break; // meno colori distinti di k
    const i = opaque[far];
    const c = [d[i], d[i + 1], d[i + 2]];
    centers.push(c);
    near.forEach((v, j) => (near[j] = Math.min(v, dist(c, d[opaque[j]], d[opaque[j] + 1], d[opaque[j] + 2]))));
  }

  const label = new Int32Array(opaque.length);
  for (let round = 0; round < 10; round++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    opaque.forEach((i, j) => {
      let best = 0;
      let bestD = Infinity;
      centers.forEach((c, n) => {
        const v = dist(c, d[i], d[i + 1], d[i + 2]);
        if (v < bestD) [best, bestD] = [n, v];
      });
      label[j] = best;
      const s = sum[best];
      s[0] += d[i];
      s[1] += d[i + 1];
      s[2] += d[i + 2];
      s[3]++;
    });
    sum.forEach((s, n) => {
      if (s[3]) centers[n] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    });
  }
  opaque.forEach((i, j) => {
    const c = centers[label[j]];
    d[i] = Math.round(c[0]);
    d[i + 1] = Math.round(c[1]);
    d[i + 2] = Math.round(c[2]);
  });
}

/** Con lo sfondo trasparente aggiunge un contorno del colore più scuro, come gli sprite. */
function outline(d: Uint8ClampedArray, n: number): void {
  let empty = 0;
  let darkest = -1;
  let darkL = Infinity;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) empty++;
    else {
      const l = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      if (l < darkL) [darkest, darkL] = [i, l];
    }
  }
  if (darkest < 0 || empty < n * n * 0.04) return;
  const ink = [d[darkest], d[darkest + 1], d[darkest + 2]];
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && d[(y * n + x) * 4 + 3] === 255;
  const edge: number[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) edge.push((y * n + x) * 4);
  for (const i of edge) {
    d.set(ink, i);
    d[i + 3] = 255;
  }
}

/** true se il ritratto ha pixel trasparenti. */
export function hasCutout(c: HTMLCanvasElement): boolean {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] === 0) return true;
  return false;
}

/** Ricostruisce un canvas da un'immagine salvata (data URL PNG). */
export function canvasFromUrl(url: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = canvas(img.naturalWidth, img.naturalHeight);
      c.getContext("2d")!.drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error(t().msg.badStored));
    img.src = url;
  });
}
