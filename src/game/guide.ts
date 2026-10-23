// Scelta della guida nel menu: ritratti predefiniti, nome e l'editor per un'immagine propria
// (tre livelli di compressione affiancati, slider del dettaglio, espressioni caricate o automatiche).
// L'immagine resta nel browser (localStorage), come le altre impostazioni.

import { EXPRESSIONS, type Expression } from "../shared/types";
import { DETAIL, PRESETS, canvasFromUrl, colorsFor, hasCutout, pixelate, readImage } from "./pixelate";
import { BUILTIN_GUIDES, GUIDE_INFO, drawStill, type CustomImage, type GuideLook } from "./portrait";
import { defaultGuideName, type GuideChoice } from "./settings";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const IMAGE_KEY = "code-dungeon:guide-image";

interface StoredImage {
  base: string;
  faces: Partial<Record<Expression, string>>;
}

const EXPRESSION_LABEL: Record<Expression, string> = {
  neutro: "Neutro",
  felice: "Felice",
  pensieroso: "Pensieroso",
  preoccupato: "Preoccupato",
  sorpreso: "Sorpreso",
};

async function loadCustomImage(): Promise<CustomImage | undefined> {
  try {
    const raw = localStorage.getItem(IMAGE_KEY);
    if (!raw) return undefined;
    const s = JSON.parse(raw) as StoredImage;
    const base = await canvasFromUrl(s.base);
    const faces: CustomImage["faces"] = {};
    for (const e of EXPRESSIONS) {
      const url = s.faces?.[e];
      if (url) faces[e] = await canvasFromUrl(url);
    }
    return { base, faces, cutout: hasCutout(base) };
  } catch {
    return undefined;
  }
}

function saveCustomImage(img: CustomImage): boolean {
  const s: StoredImage = { base: img.base.toDataURL("image/png"), faces: {} };
  for (const e of EXPRESSIONS) {
    const f = img.faces[e];
    if (f) s.faces[e] = f.toDataURL("image/png");
  }
  try {
    localStorage.setItem(IMAGE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

export interface GuidePickerHooks {
  choice(): GuideChoice;
  /** L'utente ha scelto un'altra guida o ne ha cambiato il nome. */
  onChange(choice: GuideChoice, look: GuideLook): void;
}

export class GuidePicker {
  /** Immagine salvata. */
  private custom: CustomImage | undefined;
  /** Editor: immagini originali caricate in questa sessione (servono per cambiare il dettaglio). */
  private original: ImageBitmap | undefined;
  private faceOriginals: Partial<Record<Expression, ImageBitmap>> = {};
  private presetCache = new Map<number, HTMLCanvasElement>();
  private size: number = PRESETS[1].size;
  private draft: CustomImage | undefined;
  /** Espressione per cui si sta scegliendo un file; undefined = immagine principale. */
  private faceTarget: Expression | undefined;
  private pending = 0;

  constructor(private hooks: GuidePickerHooks) {
    this.build();
  }

  /** Carica l'immagine salvata e restituisce l'aspetto della guida scelta. */
  async init(): Promise<GuideLook> {
    this.custom = await loadCustomImage();
    // immagine scelta ma non più nel browser (dati cancellati): si torna a Lumen
    if (this.hooks.choice().id === "custom" && !this.custom) this.select("lumen");
    this.renderThumbs();
    this.sync();
    return this.look(this.hooks.choice().id);
  }

  /** Allinea il menu alle impostazioni (alla riapertura). */
  sync(): void {
    const choice = this.hooks.choice();
    const input = document.getElementById(`opt-guide-${choice.id}`) as HTMLInputElement | null;
    if (input) input.checked = true;
    $<HTMLInputElement>("guide-name").value = choice.name;
    $("guide-edit").textContent = this.custom ? "Modifica la tua immagine" : "Carica la tua immagine";
  }

  private look(id: GuideChoice["id"]): GuideLook {
    if (id === "custom") return this.custom ? { kind: "custom", image: this.custom } : { kind: "builtin", id: "lumen" };
    return { kind: "builtin", id };
  }

  private select(id: GuideChoice["id"]): void {
    const prev = this.hooks.choice();
    // un nome lasciato com'era segue il ritratto; uno scelto dall'utente resta
    const name = prev.name === defaultGuideName(prev.id) ? defaultGuideName(id) : prev.name;
    this.hooks.onChange({ id, name }, this.look(id));
    this.sync();
  }

  // ---------- Costruzione ----------

  private build(): void {
    const grid = $("guide-options");
    for (const id of [...BUILTIN_GUIDES, "custom"] as const) {
      const info = id === "custom" ? { name: "La tua immagine", hint: "Foto o disegno" } : GUIDE_INFO[id];
      grid.insertAdjacentHTML(
        "beforeend",
        `<label class="option guide-option" for="opt-guide-${id}">
          <input type="radio" name="guide" id="opt-guide-${id}" value="${id}">
          <canvas class="guide-thumb" id="guide-thumb-${id}" aria-hidden="true"></canvas>
          <span class="option-name">${info.name}</span>
          <span class="option-hint">${info.hint}</span>
        </label>`,
      );
    }
    grid.addEventListener("change", (e) => {
      const id = (e.target as HTMLInputElement).value as GuideChoice["id"];
      if (id === "custom" && !this.custom) {
        this.sync(); // la scelta vale solo dopo aver salvato un'immagine
        this.openEditor();
        return;
      }
      this.select(id);
    });

    const name = $<HTMLInputElement>("guide-name");
    const commitName = (final: boolean) => {
      const choice = this.hooks.choice();
      const typed = name.value.trim().slice(0, 20);
      if (!typed && !final) return;
      this.hooks.onChange({ id: choice.id, name: typed || defaultGuideName(choice.id) }, this.look(choice.id));
      if (final) name.value = this.hooks.choice().name;
    };
    name.addEventListener("input", () => commitName(false));
    name.addEventListener("change", () => commitName(true));

    $("guide-edit").addEventListener("click", () => this.openEditor());
    $("guide-pick").addEventListener("click", () => this.pickFile(undefined));
    $<HTMLInputElement>("guide-file").addEventListener("change", (e) => void this.onFile(e.target as HTMLInputElement));
    $("guide-cancel").addEventListener("click", () => this.closeEditor());
    $("guide-save").addEventListener("click", () => this.save());

    const slider = $<HTMLInputElement>("guide-detail");
    slider.min = String(DETAIL.min);
    slider.max = String(DETAIL.max);
    slider.step = String(DETAIL.step);
    slider.addEventListener("input", () => this.setSize(Number(slider.value)));

    const presets = $("guide-presets");
    for (const p of PRESETS) {
      presets.insertAdjacentHTML(
        "beforeend",
        `<label class="option preset" for="opt-preset-${p.size}">
          <input type="radio" name="preset" id="opt-preset-${p.size}" value="${p.size}">
          <canvas class="preset-view" id="preset-view-${p.size}" aria-hidden="true"></canvas>
          <span class="option-name">${p.label}</span>
          <span class="option-hint">${p.size} px · ${colorsFor(p.size)} colori</span>
        </label>`,
      );
    }
    presets.addEventListener("change", (e) => this.setSize(Number((e.target as HTMLInputElement).value)));

    const faces = $("guide-faces");
    for (const e of EXPRESSIONS) {
      faces.insertAdjacentHTML(
        "beforeend",
        `<div class="face" data-expr="${e}">
          <canvas class="face-view" aria-hidden="true"></canvas>
          <span class="face-name">${EXPRESSION_LABEL[e]}</span>
          <span class="face-kind small muted"></span>
          <button type="button" class="chip-btn face-load">Carica</button>
          <button type="button" class="chip-btn face-auto">Automatica</button>
        </div>`,
      );
    }
    faces.addEventListener("click", (ev) => {
      const btn = (ev.target as HTMLElement).closest("button");
      const expr = btn?.closest<HTMLElement>(".face")?.dataset.expr as Expression | undefined;
      if (!btn || !expr) return;
      if (btn.classList.contains("face-load")) this.pickFile(expr);
      else this.setAuto(expr);
    });
  }

  private renderThumbs(): void {
    for (const id of BUILTIN_GUIDES) drawStill($<HTMLCanvasElement>(`guide-thumb-${id}`), { kind: "builtin", id }, "felice");
    const thumb = $<HTMLCanvasElement>("guide-thumb-custom");
    thumb.classList.toggle("is-empty", !this.custom);
    if (this.custom) drawStill(thumb, { kind: "custom", image: this.custom });
    else thumb.getContext("2d")!.clearRect(0, 0, thumb.width, thumb.height);
  }

  // ---------- Editor dell'immagine ----------

  private openEditor(): void {
    this.original = undefined;
    this.faceOriginals = {};
    this.presetCache.clear();
    this.draft = this.custom && { ...this.custom, faces: { ...this.custom.faces } };
    if (this.custom) this.size = this.custom.base.width;
    $("guide-editor").hidden = false;
    this.message("");
    this.renderEditor();
    $("guide-editor").scrollIntoView({ block: "nearest" });
    $("guide-pick").focus();
  }

  private closeEditor(): void {
    $("guide-editor").hidden = true;
    this.original = undefined;
    this.faceOriginals = {};
    this.draft = undefined;
    $("guide-edit").focus();
  }

  private pickFile(target: Expression | undefined): void {
    if (target && !this.draft) {
      this.message("Prima scegli l'immagine principale.");
      return;
    }
    this.faceTarget = target;
    $<HTMLInputElement>("guide-file").click();
  }

  private async onFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const bmp = await readImage(file);
      if (this.faceTarget) {
        this.faceOriginals[this.faceTarget] = bmp;
        this.message(`Espressione «${EXPRESSION_LABEL[this.faceTarget].toLowerCase()}» caricata.`);
      } else {
        this.original = bmp;
        this.presetCache.clear();
        $("guide-file-name").textContent = file.name;
        this.message("");
      }
      this.process();
    } catch (e) {
      this.message(e instanceof Error ? e.message : String(e));
    }
  }

  private setSize(size: number): void {
    this.size = size;
    // lo slider scorre veloce: ricalcola al più una volta per fotogramma
    cancelAnimationFrame(this.pending);
    this.pending = requestAnimationFrame(() => this.process());
  }

  private setAuto(expr: Expression): void {
    if (!this.draft) return;
    delete this.faceOriginals[expr];
    delete this.draft.faces[expr];
    this.renderEditor();
  }

  /** Riconverte le immagini originali con il dettaglio scelto. */
  private process(): void {
    const faces: CustomImage["faces"] = { ...this.draft?.faces };
    for (const e of EXPRESSIONS) {
      const src = this.faceOriginals[e];
      if (src) faces[e] = pixelate(src, this.size);
    }
    if (this.original) {
      const base = this.presetFor(this.size);
      this.draft = { base, faces, cutout: hasCutout(base) };
    } else if (this.draft) {
      this.draft = { ...this.draft, faces };
    }
    this.renderEditor();
  }

  private presetFor(size: number): HTMLCanvasElement {
    let c = this.presetCache.get(size);
    if (!c) {
      c = pixelate(this.original!, size);
      this.presetCache.set(size, c);
    }
    return c;
  }

  private renderEditor(): void {
    const hasOriginal = !!this.original;
    $("guide-tuning").hidden = !hasOriginal;
    $("guide-retune").hidden = hasOriginal || !this.draft;
    $("guide-faces-group").hidden = !this.draft;
    ($("guide-save") as HTMLButtonElement).disabled = !this.draft;
    $("guide-pick").textContent = this.draft ? "Cambia immagine" : "Scegli un'immagine";
    if (!hasOriginal) $("guide-file-name").textContent = "";

    if (hasOriginal) {
      for (const p of PRESETS) {
        drawCopy($<HTMLCanvasElement>(`preset-view-${p.size}`), this.presetFor(p.size));
        $<HTMLInputElement>(`opt-preset-${p.size}`).checked = p.size === this.size;
      }
      $<HTMLInputElement>("guide-detail").value = String(this.size);
      $("guide-detail-out").textContent = `${this.size} × ${this.size} px · ${colorsFor(this.size)} colori`;
    }

    if (!this.draft) return;
    const look: GuideLook = { kind: "custom", image: this.draft };
    for (const el of $("guide-faces").querySelectorAll<HTMLElement>(".face")) {
      const expr = el.dataset.expr as Expression;
      drawStill(el.querySelector("canvas")!, look, expr);
      const own = !!this.draft.faces[expr];
      el.querySelector(".face-kind")!.textContent = expr === "neutro" ? "Immagine principale" : own ? "Caricata" : "Automatica";
      (el.querySelector(".face-load") as HTMLElement).hidden = expr === "neutro";
      (el.querySelector(".face-auto") as HTMLElement).hidden = !own || expr === "neutro";
    }
  }

  private save(): void {
    if (!this.draft) return;
    this.custom = this.draft;
    const stored = saveCustomImage(this.custom);
    this.renderThumbs();
    $("guide-editor").hidden = true;
    this.select("custom");
    this.message(stored ? "" : "Il browser non mi lascia salvare l'immagine: vale fino alla chiusura della pagina.");
    $<HTMLInputElement>("opt-guide-custom").focus();
  }

  private message(text: string): void {
    const el = $("guide-msg");
    el.textContent = text;
    el.hidden = !text;
  }
}

function drawCopy(target: HTMLCanvasElement, src: HTMLCanvasElement): void {
  target.width = src.width;
  target.height = src.height;
  target.getContext("2d")!.drawImage(src, 0, 0);
}
