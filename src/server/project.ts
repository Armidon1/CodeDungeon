// Accesso in sola lettura ai file del progetto da spiegare, più la cartella .tour/.
// Ogni percorso passa da resolveInside(): niente "../", link simbolici o percorsi assoluti
// che escono dalla radice del progetto.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tour, TourSummary } from "../shared/types.js";

const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".idea", ".vscode", "target",
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2000;
const TOUR_DIR = ".tour";
const TOUR_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class Project {
  readonly root: string;
  private realRoot: string | undefined;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  get name(): string {
    return path.basename(this.root);
  }

  private async getRealRoot(): Promise<string> {
    this.realRoot ??= await fs.realpath(this.root);
    return this.realRoot;
  }

  /** Risolve un percorso relativo e verifica che resti dentro la radice (anche dopo i symlink). */
  async resolveInside(relPath: string): Promise<string> {
    if (typeof relPath !== "string" || relPath.length === 0) throw new Error("Percorso vuoto.");
    if (relPath.includes("\0")) throw new Error("Percorso non valido.");
    if (path.isAbsolute(relPath)) throw new Error("Usa un percorso relativo alla radice del progetto.");
    const root = await this.getRealRoot();
    const candidate = path.resolve(root, relPath);
    if (!isWithin(root, candidate)) throw new Error(`Il percorso esce dal progetto: ${relPath}`);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw new Error(`File non trovato: ${relPath}`);
    }
    if (!isWithin(root, real)) throw new Error(`Il percorso punta fuori dal progetto: ${relPath}`);
    return real;
  }

  async readFile(relPath: string): Promise<string> {
    const abs = await this.resolveInside(relPath);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new Error(`Non è un file: ${relPath}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`File troppo grande (${stat.size} byte): ${relPath}`);
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) throw new Error(`Sembra un file binario: ${relPath}`);
    return buf.toString("utf8");
  }

  async lineCount(relPath: string): Promise<number> {
    return (await this.readFile(relPath)).split("\n").length;
  }

  /** Elenco dei file del progetto, percorsi con "/" e ordinati. */
  async listFiles(): Promise<string[]> {
    const root = await this.getRealRoot();
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= MAX_FILES) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        if (e.isSymbolicLink()) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name) || e.name === TOUR_DIR) continue;
          await walk(abs);
        } else if (e.isFile()) {
          out.push(path.relative(root, abs).split(path.sep).join("/"));
        }
      }
    };
    await walk(root);
    return out;
  }

  // ---------- Tour ----------

  private async tourPath(id: string): Promise<string> {
    if (!TOUR_ID.test(id)) {
      throw new Error("Id del tour non valido: usa lettere minuscole, numeri e trattini (max 64).");
    }
    const dir = path.join(await this.getRealRoot(), TOUR_DIR);
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, `${id}.json`);
  }

  async loadTour(id: string): Promise<Tour> {
    const raw = await fs.readFile(await this.tourPath(id), "utf8").catch(() => {
      throw new Error(`Tour non trovato: ${id}`);
    });
    return JSON.parse(raw) as Tour;
  }

  async saveTour(tour: Tour): Promise<void> {
    const file = await this.tourPath(tour.id);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(tour, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);
  }

  async tourExists(id: string): Promise<boolean> {
    try {
      await fs.access(await this.tourPath(id));
      return true;
    } catch {
      return false;
    }
  }

  async listTours(): Promise<TourSummary[]> {
    const dir = path.join(await this.getRealRoot(), TOUR_DIR);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const tours: TourSummary[] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      try {
        const t = await this.loadTour(name.slice(0, -5));
        tours.push({ id: t.id, title: t.title, description: t.description, steps: t.steps.length });
      } catch {
        // file non valido: lo ignoriamo nell'elenco
      }
    }
    return tours;
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
