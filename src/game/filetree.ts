// Albero dei file nella barra laterale: cartelle che si aprono e si chiudono (chiuse di partenza),
// prima le cartelle e poi i file come in VS Code. Le cartelle aperte si ricordano per progetto in localStorage.
// Quando un tour o l'agente apre un file, le sue cartelle si aprono da sole.
// In tutor si può trascinare un file per spostarlo o usare il menu contestuale per rinominarlo o eliminarlo.

import { langOf } from "./highlight";
import { t } from "./i18n";

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
  /** true se i file si possono modificare adesso (modalità tutor). */
  canEdit(): boolean;
  /** File lasciato sulla cartella toDir ("" = radice). */
  move(path: string, toDir: string): void;
  rename(path: string): void;
  delete(path: string): void;
  references(path: string): void;
  newFile(dir: string): void;
  newFolder(dir: string): void;
}

type MenuAction = "rename" | "delete" | "references" | "newFile" | "newFolder";

export class FileTree {
  private open = new Set<string>();
  private storeKey: string | undefined;
  private menu = document.createElement("div");
  private menuItems: HTMLButtonElement[] = [];
  private menuTarget: HTMLButtonElement | undefined;

  constructor(
    private el: HTMLElement,
    private hooks: FileTreeHooks,
  ) {
    const menu = this.menu;
    menu.className = "file-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    document.body.append(menu);
    menu.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Escape" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      if (e.key === "Escape") this.dismissMenu(true);
      else {
        const current = this.menuItems.indexOf(document.activeElement as HTMLButtonElement);
        const next = current + (e.key === "ArrowDown" ? 1 : -1);
        this.menuItems.at(next % this.menuItems.length)?.focus();
      }
    });
    menu.addEventListener("focusout", (e) => {
      if (!menu.contains(e.relatedTarget as Node | null)) this.dismissMenu();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!menu.contains(e.target as Node)) this.dismissMenu();
    });
    this.el.addEventListener("scroll", () => this.dismissMenu(), true);
    window.addEventListener("resize", () => this.dismissMenu());
  }

  dismissMenu(restoreFocus = false): void {
    const target = this.menuTarget;
    this.menuTarget = undefined;
    this.menu.hidden = true;
    if (restoreFocus) target?.focus({ preventScroll: true });
  }

  openFolderMenu(btn: HTMLButtonElement, e: MouseEvent, dir: string): void {
    this.openMenu(btn, e, dir, ["newFile", "newFolder"], t().ui.folderActions);
  }

  private openMenu(btn: HTMLButtonElement, e: MouseEvent, path: string, actions: MenuAction[], label: string): void {
    if (!this.hooks.canEdit()) return;
    e.preventDefault();
    this.menuTarget = btn;
    const menu = this.menu;
    menu.setAttribute("aria-label", label);
    const labels = { rename: t().ui.rename, delete: t().ui.trashFile, references: t().ui.findReferences, newFile: t().ui.newFileHere, newFolder: t().ui.newFolder };
    this.menuItems = actions.map((action) => {
      const item = document.createElement("button");
      item.type = "button";
      item.dataset.action = action;
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.textContent = labels[action];
      item.addEventListener("click", () => {
        this.dismissMenu(true);
        if (this.hooks.canEdit()) this.hooks[action](path);
      });
      return item;
    });
    menu.replaceChildren(...this.menuItems);
    menu.hidden = false;
    const { width, height } = menu.getBoundingClientRect();
    const anchor = btn.getBoundingClientRect();
    const x = e.button === 2 ? e.clientX : anchor.left;
    const y = e.button === 2 ? e.clientY : anchor.bottom;
    menu.style.left = `${Math.max(4, Math.min(x, document.documentElement.clientWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, document.documentElement.clientHeight - height - 4))}px`;
    this.menuItems[0].focus({ preventScroll: true });
  }

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

  render(files: readonly string[], dirs: readonly string[]): void {
    this.dismissMenu();
    const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
    const ensureDir = (parts: string[]) => {
      let at = root;
      for (const [i, name] of parts.entries()) {
        let next = at.dirs.get(name);
        if (!next) at.dirs.set(name, (next = { name, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] }));
        at = next;
      }
      return at;
    };
    for (const dir of dirs) ensureDir(dir.split("/"));
    for (const file of files) {
      ensureDir(file.split("/").slice(0, -1)).files.push(file);
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
      btn.addEventListener("contextmenu", (e) => this.openFolderMenu(btn, e, sub.path));
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
      btn.addEventListener("contextmenu", (e) => this.openMenu(btn, e, file, ["rename", "delete", "references"], t().ui.fileActions));
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
      if (down.button !== 0 || !this.hooks.canEdit()) return;
      // Nella striscia orizzontale si lascia il gesto allo scorrimento.
      if (matchMedia("(max-width: 760px)").matches) return;
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
