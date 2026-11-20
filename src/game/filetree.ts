// Albero dei file nella barra laterale: cartelle che si aprono e si chiudono (chiuse di partenza),
// prima le cartelle e poi i file come in VS Code. Le cartelle aperte si ricordano per progetto in localStorage.
// Quando un tour o l'agente apre un file, le sue cartelle si aprono da sole.
// In tutor un file si trascina su una cartella (o sullo spazio vuoto, per la radice) per spostarlo.

import { langOf } from "./highlight";

const STORE_PREFIX = "code-dungeon:open-dirs:";
/** Pixel di movimento prima che la pressione diventi un trascinamento. */
const DRAG_PX = 6;
/** Fermi su una cartella chiusa per tanto così, durante il trascinamento: si apre. */
const OPEN_DELAY_MS = 700;

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: string[];
}

export interface FileTreeHooks {
  /** Clic su un file; ev serve a riconoscere Ctrl/Cmd+clic e il clic centrale. */
  open(path: string, ev: MouseEvent): void;
  /** true se i file si possono spostare adesso (modalità tutor). */
  canMove(): boolean;
  /** File lasciato sulla cartella toDir ("" = radice). */
  move(path: string, toDir: string): void;
}

export class FileTree {
  private open = new Set<string>();
  private storeKey: string | undefined;

  constructor(
    private el: HTMLElement,
    private hooks: FileTreeHooks,
  ) {}

  /** Riprende le cartelle aperte salvate per questo progetto. */
  restore(project: string): void {
    this.storeKey = STORE_PREFIX + project;
    try {
      const raw = JSON.parse(localStorage.getItem(this.storeKey) ?? "[]");
      this.open = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
    } catch {
      this.open = new Set();
    }
  }

  render(files: readonly string[]): void {
    const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
    for (const file of files) {
      const parts = file.split("/");
      let at = root;
      for (const [i, name] of parts.slice(0, -1).entries()) {
        let next = at.dirs.get(name);
        if (!next) at.dirs.set(name, (next = { name, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] }));
        at = next;
      }
      at.files.push(file);
    }
    const frag = document.createDocumentFragment();
    this.add(frag, root, 0);
    this.el.replaceChildren(frag);
    this.applyFolds();
  }

  /** Apre le cartelle che contengono path, così la sua voce si vede. */
  reveal(path: string): void {
    const parts = path.split("/");
    let changed = false;
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.open.has(dir)) {
        this.open.add(dir);
        changed = true;
      }
    }
    if (!changed) return;
    this.applyFolds();
    this.save();
  }

  private add(into: DocumentFragment, dir: Dir, depth: number): void {
    const byName = (a: string, b: string) => a.localeCompare(b);
    for (const sub of [...dir.dirs.values()].sort((a, b) => byName(a.name, b.name))) {
      const li = document.createElement("li");
      li.className = "dir";
      li.dataset.dir = sub.path;
      if (dir.path) li.dataset.parent = dir.path;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dir-btn";
      btn.style.setProperty("--depth", String(depth));
      btn.innerHTML = `<span class="dir-caret" aria-hidden="true"></span><span class="file-name"></span>`;
      btn.querySelector(".file-name")!.textContent = sub.name;
      btn.addEventListener("click", () => this.toggle(sub.path));
      li.append(btn);
      into.append(li);
      this.add(into, sub, depth + 1);
    }
    for (const file of [...dir.files].sort((a, b) => byName(a, b))) {
      const li = document.createElement("li");
      if (dir.path) li.dataset.parent = dir.path;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "file";
      btn.dataset.path = file;
      btn.style.setProperty("--depth", String(depth));
      btn.innerHTML = `<span class="file-icon ext-${langOf(file)}" aria-hidden="true"></span><span class="file-name"></span>`;
      btn.querySelector(".file-name")!.textContent = file.split("/").at(-1)!;
      btn.addEventListener("click", (e) => this.hooks.open(file, e));
      // clic centrale: come Ctrl+clic (auxclick, perché click non scatta col tasto centrale)
      btn.addEventListener("auxclick", (e) => {
        if (e.button === 1) this.hooks.open(file, e);
      });
      btn.addEventListener("mousedown", (e) => {
        if (e.button === 1) e.preventDefault(); // niente scorrimento automatico
      });
      this.dragFile(btn, file);
      li.append(btn);
      into.append(li);
    }
  }

  /** Trascinamento di un file: la cartella sotto il puntatore si illumina, al rilascio il file ci finisce dentro. */
  private dragFile(btn: HTMLButtonElement, file: string): void {
    btn.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || !this.hooks.canMove()) return;
      // striscia dei file dello schermo stretto: le cartelle non si vedono, niente dove lasciarlo
      const firstDir = this.el.querySelector(".dir");
      if (firstDir && firstDir.getClientRects().length === 0) return;
      const from = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      let dragging = false;
      let target: string | undefined;
      let lit: HTMLElement | undefined;
      let opener = 0;
      const light = (el: HTMLElement | undefined, dir: string | undefined) => {
        if (el === lit) return;
        lit?.classList.remove("is-drop");
        lit = el;
        lit?.classList.add("is-drop");
        clearTimeout(opener);
        // una cartella chiusa si apre se ci si ferma sopra
        if (dir && !this.open.has(dir)) opener = window.setTimeout(() => this.toggle(dir), OPEN_DELAY_MS);
      };
      const move = (e: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_PX) return;
          dragging = true;
          btn.setPointerCapture(e.pointerId);
          btn.classList.add("is-dragging");
          this.el.classList.add("is-moving");
        }
        // vicino ai bordi l'elenco scorre, per arrivare alle cartelle nascoste
        const r = this.el.getBoundingClientRect();
        if (e.clientY < r.top + 24) this.el.scrollTop -= 10;
        else if (e.clientY > r.bottom - 24) this.el.scrollTop += 10;
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const li = under?.closest<HTMLElement>("#" + this.el.id + " > li");
        if (li?.dataset.dir !== undefined) {
          target = li.dataset.dir;
          light(li, target);
        } else if (li) {
          // sopra un file: va nella sua cartella
          target = li.dataset.parent ?? "";
          const parent = target ? this.el.querySelector<HTMLElement>(`:scope > li[data-dir="${CSS.escape(target)}"]`) ?? undefined : this.el;
          light(parent, undefined);
        } else if (under && this.el.contains(under)) {
          target = "";
          light(this.el, undefined);
        } else {
          target = undefined;
          light(undefined, undefined);
        }
      };
      const end = (e: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (!dragging) return;
        light(undefined, undefined);
        btn.classList.remove("is-dragging");
        this.el.classList.remove("is-moving");
        // il clic che segue il rilascio non deve aprire il file
        const eat = (c: Event) => {
          c.stopImmediatePropagation();
          c.preventDefault();
        };
        btn.addEventListener("click", eat, { capture: true, once: true });
        setTimeout(() => btn.removeEventListener("click", eat, { capture: true }), 0);
        if (e.type !== "pointercancel" && target !== undefined && target !== from) this.hooks.move(file, target);
      };
      // sulla finestra: un movimento veloce può lasciare il pulsante prima che il trascinamento inizi
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    });
  }

  private toggle(dir: string): void {
    if (this.open.has(dir)) {
      this.open.delete(dir);
      // chiudere una cartella chiude anche quelle dentro
      for (const d of [...this.open]) if (d.startsWith(`${dir}/`)) this.open.delete(d);
    } else this.open.add(dir);
    this.applyFolds();
    this.save();
  }

  /** Una voce si vede se tutte le cartelle sopra di lei sono aperte. */
  private applyFolds(): void {
    const shown = (dir: string | undefined): boolean => {
      if (!dir) return true;
      const parts = dir.split("/");
      for (let i = 1; i <= parts.length; i++) if (!this.open.has(parts.slice(0, i).join("/"))) return false;
      return true;
    };
    for (const li of this.el.querySelectorAll<HTMLElement>(":scope > li")) {
      li.classList.toggle("is-folded", !shown(li.dataset.parent));
      const d = li.dataset.dir;
      if (d) {
        const on = this.open.has(d);
        li.classList.toggle("is-open", on);
        li.querySelector(".dir-btn")!.setAttribute("aria-expanded", String(on));
      }
    }
  }

  private save(): void {
    if (!this.storeKey) return;
    try {
      if (this.open.size === 0) localStorage.removeItem(this.storeKey);
      else localStorage.setItem(this.storeKey, JSON.stringify([...this.open]));
    } catch {
      // storage pieno o bloccato: le cartelle aperte valgono solo per questa pagina
    }
  }
}
