// Accesso ai file del progetto da spiegare, più la cartella .tour/.
// Ogni percorso passa da resolveInside(): niente "../", link simbolici o percorsi assoluti
// che escono dalla radice del progetto.
// L'unica scrittura nei file dell'utente è writeFile(), usata dal gioco in modalità tutor (op "write_file"
// del ponte): solo file di testo, entro MAX_FILE_BYTES, mai dentro .tour/ o .git/, scrittura atomica.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Conversation, ConversationSummary, Diagram, DiagramSummary, GapLog, Tour, TourSummary } from "../shared/types.js";

const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".idea", ".vscode", "target",
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2000;
const TOUR_DIR = ".tour";
const DIAGRAM_DIR = "schemi"; // dentro .tour/
const CONVERSATION_DIR = "conversazioni"; // dentro .tour/
const GAPS_FILE = "lacune.json"; // dentro .tour/
/** Nome di un file nuovo: niente separatori o caratteri di controllo. */
const FILE_NAME = /^[^\\/:*?"<>|\x00-\x1f]{1,128}$/;
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

  /**
   * Salva un file di testo dell'utente (modalità tutor). Il file può non esistere ancora, ma la sua cartella sì.
   * Restituisce il percorso relativo normalizzato (con "/").
   */
  async writeFile(relPath: string, content: string): Promise<string> {
    if (typeof content !== "string") throw new Error("Contenuto non valido.");
    if (content.includes("\0")) throw new Error("Solo file di testo: il contenuto ha byte nulli.");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new Error(`File troppo grande (${bytes} byte, massimo ${MAX_FILE_BYTES}).`);
    const root = await this.getRealRoot();
    let abs: string;
    try {
      abs = await this.resolveInside(relPath);
      if (!(await fs.stat(abs)).isFile()) throw new Error(`Non è un file: ${relPath}`);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("File non trovato")) throw e;
      // file nuovo: la cartella deve esistere dentro il progetto
      const name = path.basename(relPath);
      if (!name || name === "." || name === ".." || !FILE_NAME.test(name)) throw new Error(`Nome di file non valido: ${relPath}`);
      const dir = path.dirname(relPath);
      abs = path.join(dir === "." ? root : await this.resolveInside(dir), name);
    }
    const rel = path.relative(root, abs).split(path.sep);
    if (rel.some((part) => part === TOUR_DIR || part === ".git")) throw new Error("Non si scrive dentro .tour/ o .git/.");
    const tmp = `${abs}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, content, "utf8");
      await fs.rename(tmp, abs);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return rel.join("/");
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

  // ---------- Schemi della lavagna (.tour/schemi/) ----------

  private async diagramPath(id: string): Promise<string> {
    if (!TOUR_ID.test(id)) {
      throw new Error("Id dello schema non valido: usa lettere minuscole, numeri e trattini (max 64).");
    }
    const dir = path.join(await this.getRealRoot(), TOUR_DIR, DIAGRAM_DIR);
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, `${id}.json`);
  }

  async loadDiagram(id: string): Promise<Diagram> {
    const raw = await fs.readFile(await this.diagramPath(id), "utf8").catch(() => {
      throw new Error(`Schema non trovato: ${id}`);
    });
    return JSON.parse(raw) as Diagram;
  }

  async saveDiagram(diagram: Diagram): Promise<void> {
    const file = await this.diagramPath(diagram.id);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(diagram, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);
  }

  async diagramExists(id: string): Promise<boolean> {
    try {
      await fs.access(await this.diagramPath(id));
      return true;
    } catch {
      return false;
    }
  }

  async listDiagrams(): Promise<DiagramSummary[]> {
    const dir = path.join(await this.getRealRoot(), TOUR_DIR, DIAGRAM_DIR);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: DiagramSummary[] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      try {
        const d = await this.loadDiagram(name.slice(0, -5));
        out.push({ id: d.id, title: d.title, kind: d.kind });
      } catch {
        // file non valido: lo ignoriamo nell'elenco
      }
    }
    return out;
  }

  // ---------- Lacune (.tour/lacune.json) ----------

  private async gapsPath(): Promise<string> {
    const dir = path.join(await this.getRealRoot(), TOUR_DIR);
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, GAPS_FILE);
  }

  /** Il registro delle lacune; vuoto se non c'è ancora. */
  async loadGaps(): Promise<GapLog> {
    const raw = await fs.readFile(await this.gapsPath(), "utf8").catch(() => undefined);
    if (raw === undefined) return { version: 1, items: [] };
    const log = JSON.parse(raw) as GapLog;
    return { version: 1, items: Array.isArray(log.items) ? log.items : [] };
  }

  async saveGaps(log: GapLog): Promise<void> {
    const file = await this.gapsPath();
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(log, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);
  }

  // ---------- Conversazioni con l'agente (.tour/conversazioni/) ----------

  private async conversationPath(id: string): Promise<string> {
    if (!TOUR_ID.test(id)) throw new Error("Id della conversazione non valido.");
    const dir = path.join(await this.getRealRoot(), TOUR_DIR, CONVERSATION_DIR);
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, `${id}.json`);
  }

  async loadConversation(id: string): Promise<Conversation> {
    const raw = await fs.readFile(await this.conversationPath(id), "utf8").catch(() => {
      throw new Error(`Conversazione non trovata: ${id}`);
    });
    return JSON.parse(raw) as Conversation;
  }

  async saveConversation(c: Conversation): Promise<void> {
    const file = await this.conversationPath(c.id);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(c, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);
  }

  /** Dalla più recente. */
  async listConversations(): Promise<ConversationSummary[]> {
    const dir = path.join(await this.getRealRoot(), TOUR_DIR, CONVERSATION_DIR);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: ConversationSummary[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      try {
        out.push(conversationSummary(await this.loadConversation(name.slice(0, -5))));
      } catch {
        // file non valido: lo ignoriamo nell'elenco
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export function conversationSummary(c: Conversation): ConversationSummary {
  const diagrams = [...new Set(c.turns.flatMap((turn) => (turn.diagram ? [turn.diagram.id] : [])))];
  return { id: c.id, title: c.title, updatedAt: c.updatedAt, turns: c.turns.length, diagrams };
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
