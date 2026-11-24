// Sorgente demo: il progetto d'esempio incorporato nella build, senza agente.
// Importato solo nella build demo (vedi main.ts), così non pesa sulla build normale.

import type { Conversation, ConversationSummary, Diagram, DiagramSummary, EntryKind, Gap, Tour, TourSummary, TrashEntry } from "../shared/types";
import { validRenameName } from "../shared/file-name";
import { directoryContains, repathDirectory } from "../shared/project-path";
import { t } from "./i18n";
import type { ConnectionState, GameSource } from "./source";

import demoTour from "../../examples/packet-server/.tour/viaggio-di-un-pacchetto.json";

const demoDiagrams = import.meta.glob("../../examples/packet-server/.tour/schemi/*.json", {
  import: "default",
  eager: true,
}) as Record<string, Diagram>;

const demoFiles = import.meta.glob("../../examples/packet-server/*.py", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export class DemoSource implements GameSource {
  readonly kind = "demo" as const;
  projectName = "packet-server";
  agent = false;
  prefs = undefined;
  terminalUrl(): undefined {
    return undefined;
  }
  files: string[];
  dirs: string[] = [];
  private contents = new Map<string, string>();
  private trash = new Map<string, { entry: TrashEntry; content: string }>();
  private trashId = 0;
  private tour = demoTour as unknown as Tour;

  constructor() {
    for (const [key, text] of Object.entries(demoFiles)) {
      this.contents.set(key.split("/").pop()!, text);
    }
    this.files = [...this.contents.keys()].sort();
  }

  async readFile(path: string): Promise<string> {
    const text = this.contents.get(path);
    if (text === undefined) throw new Error(t().msg.notFound(path));
    return text;
  }
  /** Nella demo le modifiche restano in memoria: si perdono ricaricando la pagina. */
  async writeFile(path: string, content: string): Promise<string[]> {
    this.contents.set(path, content);
    this.files = [...this.contents.keys()].sort();
    return this.files;
  }
  async moveFile(path: string, toDir: string): Promise<string> {
    if (toDir && toDir !== "." && !this.dirs.includes(toDir)) throw new Error(t().msg.notFound(toDir));
    if (toDir === ".") toDir = "";
    return this.moveTo(path, (toDir ? `${toDir}/` : "") + path.split("/").pop()!);
  }
  async moveDirectory(from: string, toDir: string): Promise<{ from: string; to: string }> {
    if (!this.dirs.includes(from)) throw new Error(t().msg.notFound(from));
    if (toDir && !this.dirs.includes(toDir)) throw new Error(t().msg.notFound(toDir));
    if (directoryContains(from, toDir)) throw new Error(t().msg.moveIntoItself);
    const to = (toDir ? `${toDir}/` : "") + from.split("/").pop()!;
    if (from === to) return { from, to };
    if (this.contents.has(to) || this.dirs.includes(to)) throw new Error(t().msg.fileExists(to));
    const repath = (path: string) => repathDirectory(path, from, to);
    this.contents = new Map([...this.contents].map(([path, text]) => [repath(path), text]));
    this.files = [...this.contents.keys()].sort();
    this.dirs = this.dirs.map(repath);
    return { from, to };
  }
  async renameDirectory(from: string, name: string): Promise<{ from: string; to: string }> {
    if (!this.dirs.includes(from)) throw new Error(t().msg.notFound(from));
    const to = from.slice(0, from.lastIndexOf("/") + 1) + name;
    if (from === to) return { from, to };
    if (!validRenameName(name)) throw new Error(t().msg.badRenameName);
    if (this.contents.has(to) || this.dirs.includes(to)) throw new Error(t().msg.fileExists(to));
    const repath = (path: string) => repathDirectory(path, from, to);
    this.contents = new Map([...this.contents].map(([path, text]) => [repath(path), text]));
    this.files = [...this.contents.keys()].sort();
    this.dirs = this.dirs.map(repath);
    return { from, to };
  }
  async renameFile(path: string, name: string): Promise<string> {
    const dirEnd = path.lastIndexOf("/") + 1;
    if (name !== path.slice(dirEnd) && !validRenameName(name)) throw new Error(t().msg.badRenameName);
    return this.moveTo(path, path.slice(0, dirEnd) + name);
  }
  private moveTo(path: string, to: string): string {
    const text = this.contents.get(path);
    if (text === undefined) throw new Error(t().msg.notFound(path));
    if (to === path) return to;
    if (this.contents.has(to) || this.dirs.includes(to)) throw new Error(t().msg.fileExists(to));
    this.contents.delete(path);
    this.contents.set(to, text);
    this.files = [...this.contents.keys()].sort();
    return to;
  }
  async trashFile(path: string): Promise<void> {
    const content = await this.readFile(path);
    if (!this.contents.delete(path)) throw new Error(t().msg.notFound(path));
    const id = String(++this.trashId);
    this.trash.set(id, { entry: { id, path, deletedAt: new Date().toISOString() }, content });
    this.files = [...this.contents.keys()].sort();
  }
  async listTrash(): Promise<TrashEntry[]> {
    return [...this.trash.values()].reverse().map(({ entry }) => entry);
  }
  async restoreFile(id: string): Promise<string> {
    const stored = this.trash.get(id);
    if (!stored) throw new Error(t().msg.notFound(id));
    const { path } = stored.entry;
    if (this.contents.has(path) || this.dirs.includes(path)) throw new Error(t().msg.fileExists(path));
    this.trash.delete(id);
    await this.writeFile(path, stored.content);
    return path;
  }
  async createEntry(dir: string, name: string, kind: EntryKind): Promise<string> {
    if (!validRenameName(name)) throw new Error(t().msg.badRenameName);
    if (dir && !this.dirs.includes(dir)) throw new Error(t().msg.notFound(dir));
    const path = dir ? `${dir}/${name}` : name;
    if (this.contents.has(path) || this.dirs.includes(path)) throw new Error(t().msg.fileExists(path));
    if (kind === "dir") this.dirs.push(path);
    else await this.writeFile(path, "");
    return path;
  }
  async listTours(): Promise<TourSummary[]> {
    const t = this.tour;
    return [{ id: t.id, title: t.title, description: t.description, steps: t.steps.length }];
  }
  async loadTour(id: string): Promise<Tour> {
    if (id !== this.tour.id) throw new Error(t().msg.notFound(id));
    return structuredClone(this.tour);
  }
  async listDiagrams(): Promise<DiagramSummary[]> {
    return Object.values(demoDiagrams).map((d) => ({ id: d.id, title: d.title, kind: d.kind }));
  }
  async loadDiagram(id: string): Promise<Diagram> {
    const d = Object.values(demoDiagrams).find((x) => x.id === id);
    if (!d) throw new Error(t().msg.notFound(id));
    return structuredClone(d);
  }
  async listConversations(): Promise<ConversationSummary[]> {
    return [];
  }
  async loadConversation(id: string): Promise<Conversation> {
    throw new Error(t().msg.notFound(id));
  }
  async listGaps(): Promise<Gap[]> {
    return [];
  }
  async resolveGap(id: string): Promise<Gap[]> {
    throw new Error(t().msg.notFound(id));
  }
  ask(): boolean {
    return false;
  }
  async askWithAttachments(): Promise<boolean> {
    return false;
  }
  sendState(): void {}
  savePrefs(): void {}
  onPrefs(): void {}
  onFiles(): void {}
  onDirectoryMoved(): void {}
  onCommand(): void {}
  onStatus(cb: (s: ConnectionState) => void): void {
    cb("demo");
  }
  async ready(): Promise<void> {}
}
