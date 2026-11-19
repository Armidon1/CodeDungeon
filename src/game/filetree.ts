// Albero dei file nella barra laterale: cartelle che si aprono e si chiudono (chiuse di partenza),
// prima le cartelle e poi i file come in VS Code. Le cartelle aperte si ricordano per progetto in localStorage.
// Quando un tour o l'agente apre un file, le sue cartelle si aprono da sole.

import { langOf } from "./highlight";

const STORE_PREFIX = "code-dungeon:open-dirs:";

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: string[];
}

export interface FileTreeHooks {
  /** Clic su un file; ev serve a riconoscere Ctrl/Cmd+clic e il clic centrale. */
  open(path: string, ev: MouseEvent): void;
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
      li.append(btn);
      into.append(li);
    }
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
