// Sezioni ridimensionabili: larghezza dell'esplora file, altezza del pannello della guida e finestra della lavagna.
// Si trascina il divisore (o si usano le frecce quando ha il fuoco); doppio clic torna alla misura iniziale.
// Le misure restano in questo browser: sono una comodità di chi guarda, non un'impostazione del progetto.

const KEY = "code-dungeon:layout";
const SIDE_DEFAULT = 220;
const SIDE_MIN = 140;
const SIDE_MAX = 520;
/** Sotto questa larghezza l'esplora file si chiude: tutto lo spazio va al codice. */
const SIDE_CLOSE = 90;
const DIALOG_MIN = 110;
/** Il codice tiene sempre almeno queste righe di spazio. */
const EDITOR_MIN = 120;
const KEY_STEP = 24;
const POP_MIN_W = 320;
const POP_MIN_H = 180;
/** Distanza della finestra della lavagna dai bordi dell'editor (top/right in styles.css). */
const POP_GAP = 10;

interface Layout {
  /** Larghezza dell'esplora file in px; 0 = chiuso. */
  side?: number;
  /** Altezza del pannello della guida in px; undefined = quella naturale. */
  dialog?: number;
  /** Misure della finestra della lavagna in px; undefined = quelle iniziali. */
  pop?: { w: number; h: number };
}

function load(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Layout;
    return {
      side: typeof raw.side === "number" ? raw.side : undefined,
      dialog: typeof raw.dialog === "number" ? raw.dialog : undefined,
      pop:
        raw.pop && typeof raw.pop.w === "number" && typeof raw.pop.h === "number" ? { w: raw.pop.w, h: raw.pop.h } : undefined,
    };
  } catch {
    return {};
  }
}

function save(l: Layout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    // senza archiviazione le misure valgono finché la pagina resta aperta
  }
}

/** Collega i divisori e la maniglia della lavagna. onChange: le righe e le lavagne si rimisurano. */
export function initLayout(onChange: () => void): void {
  const workbench = document.querySelector<HTMLElement>(".workbench")!;
  const main = document.querySelector<HTMLElement>(".main")!;
  const dialog = document.getElementById("dialog")!;
  const sideSplit = document.getElementById("split-side")!;
  const dialogSplit = document.getElementById("split-dialog")!;
  const pop = document.getElementById("board-pop")!;
  const popGrip = document.getElementById("board-pop-grip")!;
  const layout = load();

  const applySide = () => {
    const w = layout.side ?? SIDE_DEFAULT;
    workbench.classList.toggle("is-side-closed", w === 0);
    workbench.style.setProperty("--side-w", `${w}px`);
    sideSplit.setAttribute("aria-valuenow", String(w));
  };
  const dialogMax = () => Math.max(DIALOG_MIN, main.clientHeight - EDITOR_MIN - 40);
  const applyDialog = () => {
    const h = layout.dialog === undefined ? undefined : Math.min(dialogMax(), Math.max(DIALOG_MIN, layout.dialog));
    main.classList.toggle("has-dialog-h", h !== undefined);
    if (h !== undefined) main.style.setProperty("--dialog-h", `${h}px`);
    dialogSplit.setAttribute("aria-valuenow", String(Math.round(h ?? dialog.getBoundingClientRect().height)));
  };
  const setSide = (w: number) => {
    layout.side = w < SIDE_CLOSE ? 0 : Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(w)));
    applySide();
    onChange();
  };
  const setDialog = (h: number | undefined) => {
    layout.dialog = h === undefined ? undefined : Math.round(h);
    applyDialog();
    onChange();
  };

  // la finestra sta in alto a destra: la maniglia in basso a sinistra la allarga verso il codice
  const popArea = () => pop.parentElement!.getBoundingClientRect();
  const applyPop = () => {
    const p = layout.pop;
    pop.classList.toggle("has-size", p !== undefined);
    if (!p) return;
    const area = popArea();
    // finestra nascosta o editor non ancora misurato: si rimisura alla prossima occasione
    if (area.width <= 0) return;
    const w = Math.max(POP_MIN_W, Math.min(area.width - 2 * POP_GAP, p.w));
    const h = Math.max(POP_MIN_H, Math.min(area.height - 2 * POP_GAP, p.h));
    pop.style.setProperty("--pop-w", `${Math.round(w)}px`);
    pop.style.setProperty("--pop-h", `${Math.round(h)}px`);
  };
  const setPop = (p: { w: number; h: number } | undefined) => {
    const area = popArea();
    layout.pop = p && {
      w: Math.round(Math.max(POP_MIN_W, Math.min(area.width - 2 * POP_GAP, p.w))),
      h: Math.round(Math.max(POP_MIN_H, Math.min(area.height - 2 * POP_GAP, p.h))),
    };
    applyPop();
    onChange();
  };
  const popSize = () => {
    const r = pop.getBoundingClientRect();
    return { w: r.width, h: r.height };
  };

  sideSplit.setAttribute("aria-valuemin", "0");
  sideSplit.setAttribute("aria-valuemax", String(SIDE_MAX));
  dialogSplit.setAttribute("aria-valuemin", String(DIALOG_MIN));
  applySide();
  applyDialog();
  applyPop();

  /** Trascinamento col puntatore: move riceve lo spostamento dall'inizio. */
  const drag = <T>(el: HTMLElement, start: () => T, move: (startValue: T, dx: number, dy: number) => void) => {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add("is-dragging");
      const x0 = e.clientX;
      const y0 = e.clientY;
      const v0 = start();
      const onMove = (ev: PointerEvent) => move(v0, ev.clientX - x0, ev.clientY - y0);
      const onUp = () => {
        el.classList.remove("is-dragging");
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        save(layout);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    });
  };

  // da chiuso, il trascinamento riparte da zero: basta tirare verso destra per riaprirlo
  drag(sideSplit, () => layout.side ?? SIDE_DEFAULT, (w0, dx) => setSide(w0 + dx));
  drag(dialogSplit, () => dialog.getBoundingClientRect().height, (h0, _dx, dy) => setDialog(Math.min(dialogMax(), Math.max(DIALOG_MIN, h0 - dy))));

  drag(popGrip, popSize, (p0, dx, dy) => setPop({ w: p0.w - dx, h: p0.h + dy }));

  sideSplit.addEventListener("dblclick", () => {
    setSide(SIDE_DEFAULT);
    save(layout);
  });
  dialogSplit.addEventListener("dblclick", () => {
    setDialog(undefined);
    save(layout);
  });

  sideSplit.addEventListener("keydown", (e) => {
    const w = layout.side ?? SIDE_DEFAULT;
    if (e.key === "ArrowLeft") setSide(w === SIDE_MIN ? 0 : w - KEY_STEP);
    else if (e.key === "ArrowRight") setSide(w === 0 ? SIDE_MIN : w + KEY_STEP);
    else if (e.key === "Enter") setSide(w === 0 ? SIDE_DEFAULT : 0);
    else return;
    e.preventDefault();
    e.stopPropagation();
    save(layout);
  });
  popGrip.addEventListener("dblclick", () => {
    setPop(undefined);
    save(layout);
  });
  popGrip.addEventListener("keydown", (e) => {
    const { w, h } = popSize();
    if (e.key === "ArrowLeft") setPop({ w: w + KEY_STEP, h });
    else if (e.key === "ArrowRight") setPop({ w: Math.max(POP_MIN_W, w - KEY_STEP), h });
    else if (e.key === "ArrowDown") setPop({ w, h: h + KEY_STEP });
    else if (e.key === "ArrowUp") setPop({ w, h: Math.max(POP_MIN_H, h - KEY_STEP) });
    else if (e.key === "Enter") setPop(undefined);
    else return;
    e.preventDefault();
    e.stopPropagation();
    save(layout);
  });
  dialogSplit.addEventListener("keydown", (e) => {
    const h = dialog.getBoundingClientRect().height;
    if (e.key === "ArrowUp") setDialog(Math.min(dialogMax(), h + KEY_STEP));
    else if (e.key === "ArrowDown") setDialog(Math.max(DIALOG_MIN, h - KEY_STEP));
    else if (e.key === "Enter") setDialog(undefined);
    else return;
    e.preventDefault();
    e.stopPropagation();
    save(layout);
  });

  // la finestra si rimpicciolisce: il pannello della guida non deve schiacciare il codice
  window.addEventListener("resize", () => {
    applyDialog();
    applyPop();
  });
  // la finestra si apre dopo un cambio di misure dell'editor: si riadatta allo spazio di adesso
  new MutationObserver(applyPop).observe(pop, { attributes: true, attributeFilter: ["hidden"] });
}
