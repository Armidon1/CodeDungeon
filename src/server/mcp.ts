// Server MCP: gli strumenti con cui un agente (Claude Code, Codex, Gemini CLI, ...) pilota il gioco.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EXPRESSIONS, LEVELS, type Tour, type TourStep } from "../shared/types.js";
import type { Bridge } from "./bridge.js";
import type { Project } from "./project.js";

const expression = z.enum(EXPRESSIONS).describe("Espressione del ritratto della guida.");
const level = z.enum(LEVELS);
const levelText = z
  .object({ facile: z.string(), medio: z.string(), difficile: z.string(), arduo: z.string() })
  .partial()
  .describe("Testo del fumetto per livello. In modalità istantanea compila tutti e quattro i livelli.");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string, data?: unknown): ToolResult => ({
  content: [{ type: "text", text: data === undefined ? text : `${text}\n${JSON.stringify(data, null, 2)}` }],
});
const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

export function createMcpServer(project: Project, bridge: Bridge): McpServer {
  const server = new McpServer(
    { name: "code-dungeon", version: "0.1.0" },
    {
      instructions:
        "Code Dungeon è un gioco in pixel art che spiega il codice seguendo il flusso reale del programma. " +
        "Costruisci un tour con create_tour e add_step (un passo per ogni punto del flusso, nell'ordine di esecuzione), " +
        "poi avvialo con play_tour. Durante la spiegazione controlla get_user_questions e rispondi con show_dialog, " +
        "usando highlight_lines per mostrare il codice di cui parli. Il prompt crea_tour contiene la guida completa.",
    },
  );

  const delivered = (n: number): string =>
    n > 0
      ? `Inviato al gioco (${n} ${n === 1 ? "finestra" : "finestre"}).`
      : bridge.listening
        ? `Nessuna finestra del gioco aperta: chiedi all'utente di aprire ${bridge.url}. Il comando verrà mostrato appena si collega.`
        : "Il ponte verso il gioco non è attivo (porta occupata?). Il tour viene comunque salvato.";

  const withTour = async (id: string, fn: (t: Tour) => Promise<ToolResult> | ToolResult): Promise<ToolResult> => {
    try {
      return await fn(await project.loadTour(id));
    } catch (e) {
      return fail(e);
    }
  };

  const checkLines = async (file: string, start: number, end: number): Promise<number> => {
    const count = await project.lineCount(file);
    if (start < 1 || end < start || end > count) {
      throw new Error(`Righe ${start}-${end} non valide per ${file} (il file ha ${count} righe).`);
    }
    return count;
  };

  // ---------- Esplorazione dal vivo ----------

  server.registerTool(
    "list_project_files",
    {
      title: "Elenca i file del progetto",
      description: "Elenca i file del progetto aperto in Code Dungeon (percorsi relativi alla radice).",
      inputSchema: {},
    },
    async () => {
      try {
        const files = await project.listFiles();
        return ok(`Progetto "${project.name}": ${files.length} file.`, files);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "open_file",
    {
      title: "Apri un file nell'editor",
      description: "Apre un file del progetto nell'editor pixelato, con l'animazione di spostamento della guida.",
      inputSchema: { path: z.string().describe("Percorso relativo alla radice del progetto.") },
    },
    async ({ path }) => {
      try {
        const content = await project.readFile(path);
        return ok(`${path} aperto (${content.split("\n").length} righe). ${delivered(bridge.send({ type: "open_file", path, content }))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "highlight_lines",
    {
      title: "Evidenzia righe",
      description: "Apre il file se serve ed evidenzia un intervallo di righe (incluso, da 1).",
      inputSchema: {
        path: z.string(),
        start: z.number().int().min(1),
        end: z.number().int().min(1),
      },
    },
    async ({ path, start, end }) => {
      try {
        await checkLines(path, start, end);
        const content = await project.readFile(path);
        return ok(`Righe ${start}-${end} di ${path} evidenziate. ${delivered(bridge.send({ type: "highlight", path, content, start, end }))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "show_dialog",
    {
      title: "Fai parlare la guida",
      description:
        "Mostra un fumetto della guida. Usalo per rispondere alle domande dell'utente o commentare ciò che è evidenziato. " +
        "Scrivi al livello attuale dell'utente (vedi get_game_state) e nella sua lingua.",
      inputSchema: {
        text: z.string().min(1).max(4000),
        expression: expression.optional(),
        speaker: z.string().max(40).optional().describe("Nome mostrato sopra il fumetto. Predefinito: il nome della guida."),
      },
    },
    async ({ text, expression, speaker }) => ok(`Fumetto mostrato. ${delivered(bridge.send({ type: "dialog", text, expression, speaker }))}`),
  );

  server.registerTool(
    "get_game_state",
    {
      title: "Stato del gioco",
      description: "Restituisce livello di difficoltà scelto, file e righe visibili, tour e passo correnti.",
      inputSchema: {},
    },
    async () =>
      ok(
        bridge.connected ? "Stato attuale del gioco:" : "Nessuna finestra del gioco collegata. Ultimo stato noto:",
        bridge.context ?? null,
      ),
  );

  server.registerTool(
    "get_user_questions",
    {
      title: "Leggi le domande dell'utente",
      description:
        "Restituisce (e svuota) le domande che l'utente ha scritto nel gioco, ognuna con il contesto: livello, file, righe e passo. " +
        "Rispondi a ciascuna con show_dialog, eventualmente usando highlight_lines.",
      inputSchema: {},
    },
    async () => {
      const q = bridge.takeQuestions();
      return ok(q.length ? `${q.length} domande in attesa:` : "Nessuna domanda in attesa.", q.length ? q : undefined);
    },
  );

  // ---------- Tour ----------

  server.registerTool(
    "list_tours",
    { title: "Elenca i tour", description: "Elenca i tour salvati nella cartella .tour/ del progetto.", inputSchema: {} },
    async () => {
      try {
        return ok("Tour salvati:", await project.listTours());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_tour",
    { title: "Leggi un tour", description: "Restituisce il copione JSON completo di un tour.", inputSchema: { tour_id: z.string() } },
    async ({ tour_id }) => withTour(tour_id, (t) => ok(`Tour ${t.id}:`, t)),
  );

  server.registerTool(
    "create_tour",
    {
      title: "Crea un tour",
      description:
        "Crea un tour vuoto in .tour/<tour_id>.json. Poi aggiungi i passi con add_step seguendo l'ordine di esecuzione reale del programma.",
      inputSchema: {
        tour_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe("Es. flusso-pacchetto"),
        title: z.string().min(1).max(120),
        description: z.string().max(500).optional(),
        generation: z.enum(["istantanea", "su_richiesta"]).optional(),
        overwrite: z.boolean().optional().describe("Sovrascrive un tour esistente con lo stesso id."),
      },
    },
    async ({ tour_id, title, description, generation, overwrite }) => {
      try {
        if (!overwrite && (await project.tourExists(tour_id))) {
          throw new Error(`Esiste già un tour "${tour_id}". Usa overwrite: true oppure un altro id.`);
        }
        await project.saveTour({ version: 1, id: tour_id, title, description, generation, steps: [] });
        return ok(`Tour "${tour_id}" creato. Aggiungi i passi con add_step.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_step",
    {
      title: "Aggiungi un passo al tour",
      description:
        "Aggiunge un passo: file, righe da evidenziare, espressione e testo per livello. " +
        "Con 'next' crei diramazioni (es. un handler diverso per ogni tipo di header): il gioco mostrerà una scelta.",
      inputSchema: {
        tour_id: z.string(),
        step_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional().describe("Predefinito: step-NN"),
        file: z.string(),
        start_line: z.number().int().min(1),
        end_line: z.number().int().min(1),
        title: z.string().max(80).optional(),
        expression: expression.optional(),
        text: levelText,
        next: z
          .array(z.object({ goto: z.string(), when: z.string().max(80).optional() }))
          .optional()
          .describe("Passi successivi. Ometti per andare al passo seguente; [] per finire il tour qui."),
      },
    },
    async (args) =>
      withTour(args.tour_id, async (tour) => {
        if (!Object.values(args.text).some((t) => t && t.trim())) throw new Error("Serve il testo per almeno un livello.");
        await checkLines(args.file, args.start_line, args.end_line);
        const id = args.step_id ?? `step-${String(tour.steps.length + 1).padStart(2, "0")}`;
        if (tour.steps.some((s) => s.id === id)) throw new Error(`Esiste già un passo "${id}" in questo tour.`);
        const step: TourStep = {
          id,
          file: args.file,
          lines: [args.start_line, args.end_line],
          title: args.title,
          expression: args.expression,
          text: args.text,
          next: args.next,
        };
        tour.steps.push(step);
        await project.saveTour(tour);
        return ok(`Passo "${id}" aggiunto (${tour.steps.length} passi in totale).`);
      }),
  );

  server.registerTool(
    "set_step_text",
    {
      title: "Scrivi il testo di un livello",
      description:
        "Imposta o riscrive il testo di un passo per un livello. Serve in modalità su richiesta, quando l'utente cambia livello durante il tour.",
      inputSchema: { tour_id: z.string(), step_id: z.string(), level, text: z.string().min(1).max(4000) },
    },
    async ({ tour_id, step_id, level, text }) =>
      withTour(tour_id, async (tour) => {
        const step = tour.steps.find((s) => s.id === step_id);
        if (!step) throw new Error(`Passo non trovato: ${step_id}`);
        step.text[level] = text;
        await project.saveTour(tour);
        return ok(`Testo "${level}" del passo ${step_id} aggiornato.`);
      }),
  );

  server.registerTool(
    "play_tour",
    {
      title: "Avvia un tour",
      description: "Controlla i collegamenti tra i passi e avvia il tour nel gioco, dall'inizio o da un passo dato.",
      inputSchema: { tour_id: z.string(), from_step: z.string().optional() },
    },
    async ({ tour_id, from_step }) =>
      withTour(tour_id, (tour) => {
        if (tour.steps.length === 0) throw new Error("Il tour non ha passi.");
        const ids = new Set(tour.steps.map((s) => s.id));
        const broken = tour.steps.flatMap((s) => (s.next ?? []).filter((n) => !ids.has(n.goto)).map((n) => `${s.id} → ${n.goto}`));
        if (broken.length) throw new Error(`Collegamenti verso passi inesistenti: ${broken.join(", ")}`);
        if (from_step && !ids.has(from_step)) throw new Error(`Passo non trovato: ${from_step}`);
        return ok(`Tour "${tour.title}" avviato. ${delivered(bridge.send({ type: "play_tour", tour, fromStep: from_step }))}`);
      }),
  );

  // ---------- Prompt ----------
  // In Claude Code compare come comando /mcp__code-dungeon__crea_tour; altri client lo mostrano nel loro elenco di prompt.

  server.registerPrompt(
    "crea_tour",
    {
      title: "Crea un tour di Code Dungeon",
      description: "Guida l'agente a costruire un tour che segue il flusso reale del programma.",
      argsSchema: {
        flusso: z.string().optional().describe("Il flusso da raccontare, es. 'cosa succede al login'."),
        livelli: z.string().optional().describe("istantanea (tutti i livelli) oppure un livello: facile, medio, difficile, arduo."),
      },
    },
    async ({ flusso, livelli }) => {
      const guidePath = fileURLToPath(new URL("../../docs/come-fare-un-tour.md", import.meta.url));
      const guide = await readFile(guidePath, "utf8").catch(() => "");
      const ask = [
        flusso ? `Crea un tour di Code Dungeon su questo flusso: ${flusso}.` : "Crea un tour di Code Dungeon sul flusso principale di questo progetto.",
        livelli && livelli !== "istantanea" ? `Scrivi solo il livello «${livelli}».` : "Scrivi il testo per tutti e quattro i livelli.",
        "Alla fine avvialo con play_tour.",
      ].join(" ");
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text: `${ask}\n\n${guide}` } }] };
    },
  );

  return server;
}
