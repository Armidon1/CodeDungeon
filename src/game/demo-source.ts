// Sorgente demo: il progetto d'esempio incorporato nella build, senza agente.
// Importato solo nella build demo (vedi main.ts), così non pesa sulla build normale.

import type { Diagram, DiagramSummary, Tour, TourSummary } from "../shared/types";
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
  files: string[];
  private contents = new Map<string, string>();
  private tour = demoTour as unknown as Tour;

  constructor() {
    for (const [key, text] of Object.entries(demoFiles)) {
      this.contents.set(key.split("/").pop()!, text);
    }
    this.files = [...this.contents.keys()].sort();
  }

  async readFile(path: string): Promise<string> {
    const text = this.contents.get(path);
    if (text === undefined) throw new Error(`File non trovato: ${path}`);
    return text;
  }
  async listTours(): Promise<TourSummary[]> {
    const t = this.tour;
    return [{ id: t.id, title: t.title, description: t.description, steps: t.steps.length }];
  }
  async loadTour(id: string): Promise<Tour> {
    if (id !== this.tour.id) throw new Error(`Tour non trovato: ${id}`);
    return structuredClone(this.tour);
  }
  async listDiagrams(): Promise<DiagramSummary[]> {
    return Object.values(demoDiagrams).map((d) => ({ id: d.id, title: d.title, kind: d.kind }));
  }
  async loadDiagram(id: string): Promise<Diagram> {
    const d = Object.values(demoDiagrams).find((x) => x.id === id);
    if (!d) throw new Error(`Schema non trovato: ${id}`);
    return structuredClone(d);
  }
  ask(): boolean {
    return false;
  }
  sendState(): void {}
  onCommand(): void {}
  onStatus(cb: (s: ConnectionState) => void): void {
    cb("demo");
  }
  async ready(): Promise<void> {}
}
