// Sorgente demo: il progetto d'esempio incorporato nella build, senza agente.
// Importato solo nella build demo (vedi main.ts), così non pesa sulla build normale.

import type { Tour, TourSummary } from "../shared/types";
import type { ConnectionState, GameSource } from "./source";

import demoTour from "../../examples/packet-server/.tour/viaggio-di-un-pacchetto.json";

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
