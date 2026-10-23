// Server MCP: gli strumenti con cui un agente (Claude Code, Codex, Gemini CLI, ...) pilota il gioco.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AID_INFO,
  DIAGRAM_KINDS,
  DIAGRAM_SHAPES,
  EXPRESSIONS,
  LEVELS,
  diagramPieces,
  type Diagram,
  type StepDiagram,
  type Tour,
  type TourStep,
} from "../shared/types.js";
import type { Bridge } from "./bridge.js";
import type { Project } from "./project.js";
import { log } from "./log.js";

const expression = z.enum(EXPRESSIONS).describe("Espressione del ritratto della guida.");
const level = z.enum(LEVELS);
const levelText = z
  .object({ facile: z.string(), medio: z.string(), difficile: z.string(), arduo: z.string() })
  .partial()
  .describe("Testo del fumetto per livello. In modalità istantanea compila tutti e quattro i livelli.");

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const upto = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Quanti pezzi mostrare: nodi in un flusso, messaggi in una sequenza. Ometti per lo schema completo.");
const stepDiagram = z
  .object({ id: z.string(), upto })
  .describe("Schema della lavagna da mostrare durante il passo (creato prima con draw_diagram).");

const MAX_NODES = 30;
const MAX_EDGES = 60;

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
      // canale di Claude Code: le domande scritte nel gioco arrivano nella sessione senza che l'utente torni al terminale
      capabilities: { experimental: { "claude/channel": {} } },
      instructions:
        "Code Dungeon è un gioco in pixel art che spiega il codice seguendo il flusso reale del programma. " +
        "Costruisci un tour con create_tour e add_step (un passo per ogni punto del flusso, nell'ordine di esecuzione), " +
        "poi avvialo con play_tour. Il prompt crea_tour contiene la guida completa. " +
        (bridge.listening ? `Il gioco è su ${bridge.url}: dai questo indirizzo all'utente. ` : "") +
        'Le domande che l\'utente scrive nel gioco possono arrivare da sole come <channel source="code-dungeon" question_id="..." ...>: ' +
        "rispondi subito nel gioco con show_dialog passando question_id (highlight_lines prima, se parli di altro codice). " +
        "L'utente legge la risposta nel gioco, non nel terminale. " +
        "Se le domande non arrivano da sole, dopo play_tour e dopo ogni risposta chiama wait_for_question e resta in ascolto: " +
        "l'utente non deve tornare al terminale per chiedertelo. Smetti solo se l'utente ti scrive nel terminale. " +
        "L'utente può indicare nel gioco cosa lo aiuta a capire (frasi brevi, più schemi...): lo trovi in get_game_state (reader) " +
        "e insieme alle domande. Rispettalo in ogni testo.",
    },
  );

  /** Le richieste di chi legge (questionario nel gioco), da rispettare in ogni testo. Vuoto se non ce ne sono. */
  const readerAsks = (): string[] => {
    const r = bridge.reader;
    return [...r.aids.flatMap((a) => AID_INFO[a].agent ?? []), ...(r.note ? [`nelle sue parole: «${r.note}»`] : [])];
  };
  const readerNote = (): string => {
    const asks = readerAsks();
    return asks.length ? ` Chi legge ha chiesto: ${asks.join("; ")}. Adatta così ogni testo (tour, risposte, schemi).` : "";
  };

  bridge.onQuestion = (q) => {
    const meta: Record<string, string> = { question_id: q.id, level: q.context.level };
    if (q.context.file) meta.file = q.context.file;
    if (q.context.lines) meta.lines = `${q.context.lines[0]}-${q.context.lines[1]}`;
    if (q.context.tourId) meta.tour = q.context.tourId;
    if (q.context.stepId) meta.step = q.context.stepId;
    const asks = readerAsks();
    if (asks.length) meta.aiuti = asks.join("; ");
    // se il client non ha attivato il canale la notifica viene ignorata e la domanda resta per get_user_questions
    server.server
      .notification({ method: "notifications/claude/channel", params: { content: q.text, meta } })
      .catch((e: unknown) => log(`notifica della domanda non inviata: ${String(e)}`));
  };

  const delivered = (n: number): string =>
    n > 0
      ? `Inviato al gioco (${n} ${n === 1 ? "finestra" : "finestre"}).`
      : bridge.listening
        ? `Nessuna finestra del gioco aperta: chiedi all'utente di aprire ${bridge.url}. Il comando verrà mostrato appena si collega.`
        : "Il ponte verso il gioco non è attivo (porta occupata?). Il tour viene comunque salvato.";

  /** Dopo un tour o una risposta l'agente torna in ascolto da solo: l'utente non deve chiederlo dal terminale. */
  const LISTEN =
    " Ora resta in ascolto delle domande dell'utente: chiama wait_for_question e aspettane il risultato senza chiudere il turno" +
    ' (non serve se le domande ti arrivano da sole come <channel source="code-dungeon">).';

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

  /** Controlla che uno schema sia coerente: id unici, archi tra nodi esistenti, righe di codice valide. */
  const checkDiagram = async (d: Diagram): Promise<void> => {
    const ids = new Set<string>();
    for (const n of d.nodes) {
      if (ids.has(n.id)) throw new Error(`Nodo ripetuto: ${n.id}`);
      ids.add(n.id);
      if (n.code) await checkLines(n.code.file, n.code.lines[0], n.code.lines[1]);
    }
    const missing = d.edges.flatMap((e) => [e.from, e.to]).filter((id) => !ids.has(id));
    if (missing.length) throw new Error(`Archi verso nodi inesistenti: ${[...new Set(missing)].join(", ")}`);
  };

  const checkStepDiagram = async (sd: StepDiagram | undefined): Promise<void> => {
    if (!sd) return;
    const d = await project.loadDiagram(sd.id);
    if (sd.upto !== undefined && sd.upto > diagramPieces(d)) {
      throw new Error(`Lo schema ${sd.id} ha ${diagramPieces(d)} pezzi, upto ${sd.upto} è troppo.`);
    }
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
        question_id: z.string().max(64).optional().describe("Id della domanda a cui rispondi: la toglie dalla coda di get_user_questions."),
      },
    },
    async ({ text, expression, speaker, question_id }) => {
      if (question_id) bridge.answer(question_id);
      return ok(`Fumetto mostrato. ${delivered(bridge.send({ type: "dialog", text, expression, speaker }))}${LISTEN}`);
    },
  );

  server.registerTool(
    "get_game_state",
    {
      title: "Stato del gioco",
      description:
        "Restituisce livello di difficoltà scelto, file e righe visibili, tour e passo correnti, " +
        "e le preferenze di chi legge (reader: aiuti scelti nel questionario e una nota).",
      inputSchema: {},
    },
    async () =>
      ok(
        (bridge.listening ? `Gioco su ${bridge.url}. ` : "Ponte verso il gioco non attivo. ") +
          (bridge.connected ? "Stato attuale del gioco:" : "Nessuna finestra del gioco collegata. Ultimo stato noto:") +
          readerNote(),
        { ...bridge.context, reader: bridge.reader },
      ),
  );

  server.registerTool(
    "get_user_questions",
    {
      title: "Leggi le domande dell'utente",
      description:
        "Restituisce (e svuota) le domande senza risposta che l'utente ha scritto nel gioco, ognuna con il contesto: livello, file, righe e passo. " +
        "Rispondi a ciascuna con show_dialog, eventualmente usando highlight_lines.",
      inputSchema: {},
    },
    async () => {
      const q = bridge.takeQuestions();
      if (q.length === 0) return ok("Nessuna domanda in attesa.");
      return ok(`${q.length === 1 ? "1 domanda in attesa." : `${q.length} domande in attesa.`}${readerNote()}`, q);
    },
  );

  server.registerTool(
    "wait_for_question",
    {
      title: "Resta in ascolto delle domande",
      description:
        "Aspetta che l'utente scriva una domanda nel gioco e la restituisce con il contesto (anche quelle già in coda). " +
        "Aspetta il risultato senza chiudere il turno: l'utente sta usando il gioco e legge le risposte lì. " +
        "Rispondi con show_dialog passando question_id, poi richiamalo per restare in ascolto. " +
        "Utile quando le domande non arrivano da sole nella sessione.",
      inputSchema: {
        timeout_seconds: z.number().int().min(5).max(1800).optional().describe("Quanto aspettare al massimo. Predefinito: 300."),
      },
    },
    async ({ timeout_seconds }, extra) => {
      const q = await bridge.waitQuestions((timeout_seconds ?? 300) * 1000, extra.signal);
      if (q.length === 0) return ok("Nessuna domanda nel frattempo. Richiama subito wait_for_question: l'utente è ancora nel gioco.");
      return ok(
        `${q.length === 1 ? "1 domanda" : `${q.length} domande`}. Rispondi ora nel gioco con show_dialog passando question_id, poi richiama wait_for_question.${readerNote()}`,
        q,
      );
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
        return ok(`Tour "${tour_id}" creato. Aggiungi i passi con add_step.${readerNote()}`);
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
        diagram: stepDiagram.optional(),
      },
    },
    async (args) =>
      withTour(args.tour_id, async (tour) => {
        if (!Object.values(args.text).some((t) => t && t.trim())) throw new Error("Serve il testo per almeno un livello.");
        await checkLines(args.file, args.start_line, args.end_line);
        await checkStepDiagram(args.diagram);
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
          diagram: args.diagram,
        };
        tour.steps.push(step);
        await project.saveTour(tour);
        return ok(`Passo "${id}" aggiunto (${tour.steps.length === 1 ? "1 passo" : `${tour.steps.length} passi`} in totale).`);
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
    "set_step_diagram",
    {
      title: "Collega uno schema a un passo",
      description:
        "Mostra uno schema della lavagna durante un passo del tour, intero o fino a un certo pezzo. " +
        "Usa lo stesso schema su passi consecutivi con upto crescente per disegnarlo mentre il tour avanza. diagram_id vuoto lo scollega.",
      inputSchema: { tour_id: z.string(), step_id: z.string(), diagram_id: z.string(), upto },
    },
    async ({ tour_id, step_id, diagram_id, upto }) =>
      withTour(tour_id, async (tour) => {
        const step = tour.steps.find((s) => s.id === step_id);
        if (!step) throw new Error(`Passo non trovato: ${step_id}`);
        if (diagram_id) {
          await checkStepDiagram({ id: diagram_id, upto });
          step.diagram = { id: diagram_id, upto };
        } else {
          delete step.diagram;
        }
        await project.saveTour(tour);
        return ok(diagram_id ? `Schema ${diagram_id} collegato al passo ${step_id}.` : `Schema scollegato dal passo ${step_id}.`);
      }),
  );

  server.registerTool(
    "play_tour",
    {
      title: "Avvia un tour",
      description: "Controlla i collegamenti tra i passi e gli schemi, poi avvia il tour nel gioco, dall'inizio o da un passo dato.",
      inputSchema: { tour_id: z.string(), from_step: z.string().optional() },
    },
    async ({ tour_id, from_step }) =>
      withTour(tour_id, async (tour) => {
        if (tour.steps.length === 0) throw new Error("Il tour non ha passi.");
        const ids = new Set(tour.steps.map((s) => s.id));
        const broken = tour.steps.flatMap((s) => (s.next ?? []).filter((n) => !ids.has(n.goto)).map((n) => `${s.id} → ${n.goto}`));
        if (broken.length) throw new Error(`Collegamenti verso passi inesistenti: ${broken.join(", ")}`);
        if (from_step && !ids.has(from_step)) throw new Error(`Passo non trovato: ${from_step}`);
        for (const s of tour.steps) await checkStepDiagram(s.diagram).catch((e) => Promise.reject(new Error(`Passo ${s.id}: ${e.message}`)));
        return ok(`Tour "${tour.title}" avviato. ${delivered(bridge.send({ type: "play_tour", tour, fromStep: from_step }))}${LISTEN}`);
      }),
  );

  // ---------- Lavagna degli schemi ----------

  server.registerTool(
    "draw_diagram",
    {
      title: "Disegna uno schema",
      description:
        "Disegna uno schema in pixel art sulla lavagna del gioco: si apre in una finestra sopra il codice e resta in una scheda dell'editor. " +
        "Viene salvato in .tour/schemi/<diagram_id>.json. 'flusso' per diagrammi di flusso e architetture (nodi nell'ordine di esecuzione), " +
        "'sequenza' per chiamate tra componenti (i nodi sono i partecipanti, gli archi i messaggi in ordine di tempo). " +
        "Con upto lo schema compare a pezzi: poi aggiungine con reveal_diagram mentre spieghi.",
      inputSchema: {
        diagram_id: slug.describe("Es. flusso-login"),
        title: z.string().min(1).max(80),
        kind: z.enum(DIAGRAM_KINDS),
        nodes: z
          .array(
            z.object({
              id: z.string().min(1).max(40),
              label: z.string().min(1).max(60).describe("Testo breve, 1-4 parole."),
              shape: z
                .enum(DIAGRAM_SHAPES)
                .optional()
                .describe("stanza: passo o componente (predefinito); bivio: decisione; archivio: dati o file; attore: utente o sistema esterno."),
              code: z
                .object({ file: z.string(), start: z.number().int().min(1), end: z.number().int().min(1) })
                .optional()
                .describe("Codice del nodo: l'utente lo apre con un clic."),
            }),
          )
          .min(1)
          .max(MAX_NODES),
        edges: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              label: z.string().max(40).optional(),
              style: z.enum(["pieno", "tratteggiato"]).optional().describe("tratteggiato: risposta, chiamata asincrona o caso d'errore."),
            }),
          )
          .max(MAX_EDGES),
        upto,
        overwrite: z.boolean().optional().describe("Sovrascrive uno schema esistente con lo stesso id."),
      },
    },
    async (args) => {
      try {
        if (!args.overwrite && (await project.diagramExists(args.diagram_id))) {
          throw new Error(`Esiste già uno schema "${args.diagram_id}". Usa overwrite: true oppure un altro id.`);
        }
        const diagram: Diagram = {
          version: 1,
          id: args.diagram_id,
          title: args.title,
          kind: args.kind,
          nodes: args.nodes.map((n) => ({
            id: n.id,
            label: n.label,
            shape: n.shape,
            code: n.code ? { file: n.code.file, lines: [n.code.start, n.code.end] } : undefined,
          })),
          edges: args.edges,
        };
        await checkDiagram(diagram);
        await project.saveDiagram(diagram);
        const pieces = diagramPieces(diagram);
        const shown = args.upto === undefined ? "completo" : `${Math.min(args.upto, pieces)} di ${pieces} pezzi`;
        return ok(`Schema "${diagram.id}" salvato e mostrato (${shown}). ${delivered(bridge.send({ type: "diagram", diagram, upto: args.upto }))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "reveal_diagram",
    {
      title: "Mostra uno schema",
      description:
        "Riapre uno schema salvato nella finestra della lavagna. Con upto più alto di prima disegna i pezzi nuovi con l'animazione: " +
        "usalo per tracciare lo schema mentre spieghi. Ometti upto per mostrarlo tutto.",
      inputSchema: { diagram_id: z.string(), upto },
    },
    async ({ diagram_id, upto }) => {
      try {
        const diagram = await project.loadDiagram(diagram_id);
        const pieces = diagramPieces(diagram);
        const shown = upto === undefined ? "completo" : `${Math.min(upto, pieces)} di ${pieces} pezzi`;
        return ok(`Schema "${diagram_id}" mostrato (${shown}). ${delivered(bridge.send({ type: "diagram", diagram, upto }))}`);
      } catch (e) {
        return fail(e);
      }
    },
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
      ].join(" ") + readerNote();
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text: `${ask}\n\n${guide}` } }] };
    },
  );

  return server;
}
