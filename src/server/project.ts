// Accesso ai file del progetto da spiegare, più la cartella .tour/.
// Ogni percorso passa da resolveInside(): niente "../", link simbolici o percorsi assoluti
// che escono dalla radice del progetto.
// Il gioco in modalità tutor può salvare, spostare, rinominare ed eliminare file, esclusi .tour/ e .git/.

import { constants, lstatSync, mkdirSync, promises as fs, renameSync, rmdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { validRenameName } from "../shared/file-name.js";
import { QUESTION_TEXT_BYTES, QUESTION_IMAGE_WIRE, type Conversation, type ConversationSummary, type Diagram, type DiagramSummary, type EntryKind, type GapLog, type MovedDirectory, type ProjectTree, type QuestionImage, type Tour, type TourSummary, type TrashEntry } from "../shared/types.js";
import { validateQuestionImages } from "./question-images.js";

const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".idea", ".vscode", "target",
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2000;
const TOUR_DIR = ".tour";
const DIAGRAM_DIR = "schemi"; // dentro .tour/
const CONVERSATION_DIR = "conversazioni"; // dentro .tour/
const QUESTION_TEXT_DIR = `${TOUR_DIR}/${CONVERSATION_DIR}/testi`;
const QUESTION_IMAGE_DIR = `${TOUR_DIR}/${CONVERSATION_DIR}/immagini`;
const GAPS_FILE = "lacune.json"; // dentro .tour/
const TRASH_DIR = `${TOUR_DIR}/cestino`;
const UUID_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
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

  /**
   * Sposta un file dell'utente nella cartella toDir ("" = radice), con lo stesso nome (modalità tutor).
   * Non sovrascrive un file che c'è già. Restituisce il percorso relativo nuovo (con "/").
   */
  async moveFile(relPath: string, toDir: string): Promise<string> {
    const root = await this.getRealRoot();
    const from = await this.resolveRegularFile(relPath, root);
    const dir = await this.editableDirectory(root, toDir);
    return this.relocateFile(root, from, path.join(dir, path.basename(from)));
  }

  async moveDirectory(relPath: string, toDir: string): Promise<MovedDirectory> {
    if (typeof relPath !== "string" || typeof toDir !== "string") throw new Error("Percorso non valido.");
    const root = await this.getRealRoot();
    const from = await this.editableDirectory(root, relPath);
    if (from === root) throw new Error("La radice del progetto non si può spostare.");
    const dir = await this.editableDirectory(root, toDir);
    if (isWithin(from, dir)) throw new Error("Destinazione dentro la cartella da spostare.");
    const to = path.join(dir, path.basename(from));
    this.checkEditable(root, to);
    const moved = { from: relativePath(root, from), to: relativePath(root, to) };
    if (from === to) return moved;

    const conflict = () => new Error(`C'è già un elemento con questo nome: ${moved.to}`);
    if (process.platform === "win32") {
      // MoveFileEx rifiuta una cartella di destinazione già esistente.
      if (lstatSync(to, { throwIfNoEntry: false })) throw conflict();
      renameSync(from, to);
    } else {
      // Su POSIX rename può sostituire una cartella vuota. Prima riserviamo il nome con mkdir esclusivo.
      try {
        mkdirSync(to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw conflict();
        throw e;
      }
      try {
        renameSync(from, to);
      } catch (e) {
        rmdirSync(to);
        throw e;
      }
    }
    return moved;
  }

  /** Rinomina un file dell'utente lasciandolo nella stessa cartella. */
  async renameFile(relPath: string, name: string): Promise<string> {
    const root = await this.getRealRoot();
    const from = await this.resolveRegularFile(relPath, root);
    if (name !== path.basename(from) && !validRenameName(name)) throw new Error("Nome del file non valido.");
    return this.relocateFile(root, from, path.join(path.dirname(from), name));
  }

  private async relocateFile(root: string, from: string, to: string): Promise<string> {
    this.checkEditable(root, from);
    this.checkEditable(root, to);
    const rel = relativePath(root, to);
    if (to !== from) await this.transferFile(from, to, rel);
    return rel;
  }

  private checkEditable(root: string, abs: string): void {
    if (path.relative(root, abs).split(path.sep).some((part) => [TOUR_DIR, ".git"].includes(part.toLowerCase()))) {
      throw new Error("I file in .tour/ e .git/ sono protetti.");
    }
  }

  private async transferFile(from: string, to: string, rel: string): Promise<void> {
    // link al posto di rename: fallisce se la destinazione esiste già, così niente viene sovrascritto
    try {
      await fs.link(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // Su un file system che ignora le maiuscole, il nome nuovo può indicare la stessa voce.
        const dir = path.dirname(from);
        const oldName = path.basename(from);
        const newName = path.basename(to);
        if (dir === path.dirname(to) && oldName.toLowerCase() === newName.toLowerCase()) {
          const entries = await fs.readdir(dir);
          if (entries.includes(oldName) && !entries.includes(newName)) {
            await fs.rename(from, to);
            return;
          }
        }
        throw new Error(`C'è già un file con questo nome: ${rel}`);
      }
      if (!["EXDEV", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code ?? "")) throw e;
      // File system senza link fisici o diversi: copia esclusiva, poi rimuove la sorgente.
      await fs.copyFile(from, to, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") throw new Error(`C'è già un file con questo nome: ${rel}`);
        throw error;
      });
    }
    try {
      await fs.unlink(from);
    } catch (e) {
      await fs.unlink(to).catch(() => {});
      throw e;
    }
  }

  /** Sposta un file nel cestino del progetto e restituisce il percorso che aveva. */
  async deleteFile(relPath: string): Promise<string> {
    const root = await this.getRealRoot();
    const abs = await this.resolveRegularFile(relPath, root);
    this.checkEditable(root, abs);
    const trash = await this.metadataDirectory(root, TRASH_DIR, true);
    if (!trash) throw new Error("Cestino non accessibile.");
    const entry: TrashEntry = { id: randomUUID(), path: relativePath(root, abs), deletedAt: new Date().toISOString() };
    const folder = path.join(trash, entry.id);
    await fs.mkdir(folder);
    try {
      await fs.writeFile(path.join(folder, "entry.json"), JSON.stringify(entry), { flag: "wx" });
      await this.transferFile(abs, path.join(folder, "file"), entry.path);
    } catch (e) {
      await this.cleanTrashFolder(folder);
      throw e;
    }
    return entry.path;
  }

  async listTrash(): Promise<TrashEntry[]> {
    const root = await this.getRealRoot();
    const trash = await this.metadataDirectory(root, TRASH_DIR);
    if (!trash) return [];
    const entries: TrashEntry[] = [];
    for (const id of await fs.readdir(trash)) {
      if (!UUID_ID.test(id)) continue;
      const entry = await this.readTrashEntry(root, id).catch(() => undefined);
      if (entry) entries.push(entry);
    }
    return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  async restoreFile(id: string): Promise<string> {
    const root = await this.getRealRoot();
    const entry = await this.readTrashEntry(root, id);
    const dest = path.resolve(root, entry.path);
    this.checkEditable(root, dest);
    const parents = entry.path.split("/").slice(0, -1);
    for (let i = 1; i <= parents.length; i++) {
      const rel = parents.slice(0, i).join("/");
      await fs.mkdir(path.join(root, rel)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
      await this.editableDirectory(root, rel);
    }
    const from = await this.resolveRegularFile(`${TRASH_DIR}/${id}/file`, root);
    await this.transferFile(from, dest, entry.path);
    await this.cleanTrashFolder(path.dirname(from));
    return entry.path;
  }

  private async metadataDirectory(root: string, target: string, create = false): Promise<string | undefined> {
    const parts = target.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const rel = parts.slice(0, i).join("/");
      const abs = path.join(root, rel);
      if (create) {
        await fs.mkdir(abs).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "EEXIST") throw e;
        });
      } else if (!(await fs.lstat(abs).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      }))) return undefined;
      if ((await this.resolveInside(rel)) !== abs || !(await fs.lstat(abs)).isDirectory()) throw new Error(`Cartella non accessibile: ${rel}`);
    }
    return path.join(root, target);
  }

  private async readTrashEntry(root: string, id: string): Promise<TrashEntry> {
    if (typeof id !== "string" || !UUID_ID.test(id)) throw new Error("Elemento del cestino non valido.");
    const folder = `${TRASH_DIR}/${id}`;
    const meta = await this.resolveRegularFile(`${folder}/entry.json`, root);
    await this.resolveRegularFile(`${folder}/file`, root);
    const entry = JSON.parse(await fs.readFile(meta, "utf8")) as TrashEntry;
    const original = entry.path;
    if (typeof original !== "string" || !original || original.includes("\0") || !isWithin(root, path.resolve(root, original)) ||
        relativePath(root, path.resolve(root, original)) !== original || typeof entry.deletedAt !== "string") {
      throw new Error("Elemento del cestino non valido.");
    }
    return { id, path: original, deletedAt: entry.deletedAt };
  }

  private async cleanTrashFolder(folder: string): Promise<void> {
    await fs.unlink(path.join(folder, "entry.json")).catch(() => {});
    await fs.rmdir(folder).catch(() => {});
  }

  async createEntry(dir: string, name: string, kind: EntryKind): Promise<string> {
    if (!validRenameName(name) || (kind === "dir" && IGNORED_DIRS.has(name))) throw new Error("Nome non valido.");
    const root = await this.getRealRoot();
    const target = path.join(await this.editableDirectory(root, dir), name);
    this.checkEditable(root, target);
    try {
      if (kind === "dir") await fs.mkdir(target);
      else if (kind === "file") await fs.writeFile(target, "", { flag: "wx" });
      else throw new Error("Tipo di elemento non valido.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" || (e as NodeJS.ErrnoException).code === "EISDIR") {
        throw new Error(`C'è già un elemento con questo nome: ${name}`);
      }
      throw e;
    }
    return relativePath(root, target);
  }

  private async editableDirectory(root: string, dir: string): Promise<string> {
    if (dir === "") return root;
    const abs = await this.resolveInside(dir);
    this.checkEditable(root, abs);
    if (abs !== path.resolve(root, dir) || !(await fs.lstat(abs)).isDirectory()) throw new Error(`Non è una cartella: ${dir}`);
    return abs;
  }

  private async resolveRegularFile(relPath: string, root: string): Promise<string> {
    const abs = await this.resolveInside(relPath);
    if (abs !== path.resolve(root, relPath) || !(await fs.lstat(abs)).isFile()) {
      throw new Error(`Non è un file regolare: ${relPath}`);
    }
    return abs;
  }

  async lineCount(relPath: string): Promise<number> {
    return (await this.readFile(relPath)).split("\n").length;
  }

  /** Elenco dei file del progetto, percorsi con "/" e ordinati. */
  async listFiles(): Promise<string[]> {
    return (await this.listTree()).files;
  }

  async listTree(): Promise<ProjectTree> {
    const root = await this.getRealRoot();
    const files: string[] = [];
    const dirs: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (files.length >= MAX_FILES) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (files.length >= MAX_FILES) return;
        if (e.isSymbolicLink()) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name) || e.name === TOUR_DIR) continue;
          dirs.push(relativePath(root, abs));
          await walk(abs);
        } else if (e.isFile()) {
          files.push(relativePath(root, abs));
        }
      }
    };
    await walk(root);
    return { files, dirs };
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

  async saveQuestionText(id: string, text: string): Promise<number> {
    if (!UUID_ID.test(id)) throw new Error("Id della domanda non valido.");
    const bytes = Buffer.byteLength(text);
    if (!bytes || bytes > QUESTION_TEXT_BYTES) throw new Error("Il testo allegato deve avere da 1 byte a 5 MiB.");
    const dir = await this.metadataDirectory(await this.getRealRoot(), QUESTION_TEXT_DIR, true);
    if (!dir) throw new Error("Cartella dei testi non accessibile.");
    await fs.writeFile(path.join(dir, `${id}.txt`), text, { flag: "wx", mode: 0o600 });
    return bytes;
  }

  private async questionTextPath(id: string): Promise<string> {
    if (!UUID_ID.test(id)) throw new Error("Id della domanda non valido.");
    return this.resolveRegularFile(`${QUESTION_TEXT_DIR}/${id}.txt`, await this.getRealRoot());
  }

  async discardQuestionText(id: string): Promise<void> {
    await fs.unlink(await this.questionTextPath(id));
  }

  async readQuestionText(id: string, offset: number): Promise<{ text: string; offset: number; nextOffset: number; totalBytes: number }> {
    const file = await fs.open(await this.questionTextPath(id), "r");
    try {
      const { size } = await file.stat();
      if (size > QUESTION_TEXT_BYTES || offset < 0 || offset > size) throw new Error("Intervallo del testo non valido.");
      const page = Buffer.alloc(Math.min(8192, size - offset));
      const { bytesRead } = await file.read(page, 0, page.length, offset);
      // Un offset libero può cadere dentro un carattere UTF-8. I cursori restituiti cadono sempre tra caratteri.
      let start = 0;
      while (start < bytesRead && (page[start] & 0xc0) === 0x80) start++;
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(page.subarray(start, bytesRead), { stream: offset + bytesRead < size });
      const first = offset + start;
      return { text, offset: first, nextOffset: first + Buffer.byteLength(text), totalBytes: size };
    } finally {
      await file.close();
    }
  }

  /** Le immagini sono salvate a parte, una volta sola per domanda. */
  async saveQuestionImages(id: string, images: unknown): Promise<number> {
    if (!UUID_ID.test(id)) throw new Error("Id della domanda non valido.");
    const checked = validateQuestionImages(images);
    const dir = await this.metadataDirectory(await this.getRealRoot(), QUESTION_IMAGE_DIR, true);
    if (!dir) throw new Error("Cartella delle immagini non accessibile.");
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(checked), { flag: "wx", mode: 0o600 });
    return checked.length;
  }

  async loadQuestionImages(id: string): Promise<QuestionImage[]> {
    if (!UUID_ID.test(id)) throw new Error("Id della domanda con immagini non valido.");
    const file = await this.resolveRegularFile(`${QUESTION_IMAGE_DIR}/${id}.json`, await this.getRealRoot());
    if ((await fs.stat(file)).size > QUESTION_IMAGE_WIRE + 1024) throw new Error("Gli allegati della domanda sono troppo grandi.");
    return validateQuestionImages(JSON.parse(await fs.readFile(file, "utf8")));
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
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function relativePath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}
