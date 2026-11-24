// Albero dei file nella barra laterale: cartelle che si aprono e si chiudono (chiuse di partenza),
// prima le cartelle e poi i file come in VS Code. Le cartelle aperte si ricordano per progetto in localStorage.
// Quando un tour o l'agente apre un file, le sue cartelle si aprono da sole.
// In tutor si possono trascinare file e cartelle per spostarli.

import { directoryContains } from "../shared/project-path";
import type { EntryKind } from "../shared/types";
import { langOf } from "./highlight";
import { t } from "./i18n";

const STORE_PREFIX = "code-dungeon:open-dirs:";
/** Pixel di movimento prima che la pressione diventi un trascinamento. */
const DRAG_PX = 6;
/** Fermi su una cartella chiusa per tanto così, durante il trascinamento: si apre. */
const OPEN_DELAY_MS = 700;
const ARRIVAL_MS = 850;

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
  /** Elemento lasciato sulla cartella toDir ("" = radice). */
  move(path: string, toDir: string, kind: EntryKind): void;
  moveFolder(path: string): void;
  rename(path: string): void;
  delete(path: string): void;
  references(path: string): void;
  newFile(dir: string): void;
  newFolder(dir: string): void;
}

type MenuAction = "rename" | "delete" | "references" | "newFile" | "newFolder" | "moveFolder";

export class FileTree {
  private open = new Set<string>();
  private storeKey: string | undefined;
  private arrivedDirectory: string | undefined;
  private arrivalTimer: number | undefined;
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
    const actions: MenuAction[] = ["newFile", "newFolder"];
    if (dir) actions.push("moveFolder");
    this.openMenu(btn, e, dir, actions, t().ui.folderActions);
  }

  private openMenu(btn: HTMLButtonElement, e: MouseEvent, path: string, actions: MenuAction[], label: string): void {
    if (!this.hooks.canEdit()) return;
    e.preventDefault();
    this.menuTarget = btn;
    const menu = this.menu;
    menu.setAttribute("aria-label", label);
    const ui = t().ui;
    const labels = { rename: ui.rename, delete: ui.trashFile, references: ui.findReferences, newFile: ui.newFileHere, newFolder: ui.newFolder, moveFolder: ui.moveFolder };
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
    const focused = this.el.contains(document.activeElement)
      ? document.activeElement?.closest<HTMLElement>("[data-dir], .file[data-path]")
      : undefined;
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
    const focusedPath = focused?.dataset.dir ?? focused?.dataset.path;
    if (focusedPath) this.entryButton(focusedPath, focused?.dataset.dir ? "dir" : "file")?.focus({ preventScroll: true });
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

  repathFolders(repath: (path: string) => string): void {
    this.open = new Set([...this.open].map(repath));
    this.save();
  }

  /** Fa risaltare la cartella spostata anche se il ponte aggiorna l'albero. */
  showArrival(path: string): void {
    const clear = () => this.el.querySelector(".dir-arrived")?.classList.remove("dir-arrived");
    clear();
    this.arrivedDirectory = path;
    this.folderRow(path)?.classList.add("dir-arrived");
    clearTimeout(this.arrivalTimer);
    this.arrivalTimer = window.setTimeout(() => {
      this.arrivedDirectory = undefined;
      clear();
    }, ARRIVAL_MS);
  }

  focusEntry(path: string, kind: EntryKind): void {
    const button = this.entryButton(path, kind);
    button?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    button?.focus({ preventScroll: true });
  }

  private entryButton(path: string, kind: EntryKind): HTMLButtonElement | null | undefined {
    return kind === "dir"
      ? this.folderRow(path)?.querySelector<HTMLButtonElement>(".dir-btn")
      : this.el.querySelector<HTMLButtonElement>(`.file[data-path="${CSS.escape(path)}"]`);
  }

  private folderRow(path: string): HTMLElement | null {
    return this.el.querySelector<HTMLElement>(`:scope > li[data-dir="${CSS.escape(path)}"]`);
  }

  private add(into: DocumentFragment, dir: Dir, depth: number): void {
    const byName = (a: string, b: string) => a.localeCompare(b);
    for (const sub of [...dir.dirs.values()].sort((a, b) => byName(a.name, b.name))) {
      const li = document.createElement("li");
      li.className = "dir";
      li.classList.toggle("dir-arrived", sub.path === this.arrivedDirectory);
      li.dataset.dir = sub.path;
      if (dir.path) li.dataset.parent = dir.path;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dir-btn";
      btn.style.setProperty("--depth", String(depth));
      btn.innerHTML = `<span class="dir-caret" aria-hidden="true"></span><span class="dir-icon" aria-hidden="true"><span class="dir-sparkle"></span></span><span class="file-name"></span>`;
      btn.querySelector(".file-name")!.textContent = sub.name;
      btn.addEventListener("click", () => this.toggle(sub.path));
      btn.addEventListener("contextmenu", (e) => this.openFolderMenu(btn, e, sub.path));
      this.dragEntry(btn, sub.path, dir.path, "dir");
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
      this.dragEntry(btn, file, dir.path, "file");
      li.append(btn);
      into.append(li);
    }
  }

  /** La cartella sotto il puntatore si illumina se può ricevere l'elemento trascinato. */
  private dragEntry(btn: HTMLButtonElement, path: string, from: string, kind: EntryKind): void {
    btn.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || !this.hooks.canEdit()) return;
      // Nella striscia orizzontale si lascia il gesto allo scorrimento.
      if (matchMedia("(max-width: 760px)").matches) return;
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
        if (e.pointerId !== down.pointerId) return;
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
        target = li ? li.dataset.dir ?? li.dataset.parent ?? "" : under && this.el.contains(under) ? "" : undefined;
        if (target === undefined || (kind === "dir" && (target === from || directoryContains(path, target)))) {
          target = undefined;
          light(undefined, undefined);
        } else if (li?.dataset.dir !== undefined) {
          light(li, target);
        } else if (li) {
          // sopra un file: va nella sua cartella
          const parent = target ? this.el.querySelector<HTMLElement>(`:scope > li[data-dir="${CSS.escape(target)}"]`) ?? undefined : this.el;
          light(parent, undefined);
        } else {
          light(this.el, undefined);
        }
      };
      const end = (e: PointerEvent) => {
        if (e.pointerId !== down.pointerId) return;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (!dragging) return;
        light(undefined, undefined);
        btn.classList.remove("is-dragging");
        this.el.classList.remove("is-moving");
        // Ignora il clic che segue il rilascio.
        const eat = (c: Event) => {
          c.stopImmediatePropagation();
          c.preventDefault();
        };
        btn.addEventListener("click", eat, { capture: true, once: true });
        setTimeout(() => btn.removeEventListener("click", eat, { capture: true }), 0);
        if (e.type !== "pointercancel" && target !== undefined && target !== from) this.hooks.move(path, target, kind);
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
