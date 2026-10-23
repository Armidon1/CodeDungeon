// Prova end-to-end: avvia il server MCP sul progetto d'esempio, si collega come un agente
// (client MCP su stdio) e come il gioco (WebSocket), e verifica che i comandi arrivino.
//   npm run test:mcp

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const PORT = 7400 + Math.floor(Math.random() * 500); // porta casuale: evita conflitti con esecuzioni precedenti
const project = path.resolve("examples/packet-server");
const TOUR = "prova-automatica";
// preferenze in una cartella temporanea: il test non tocca quelle dell'utente
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-dungeon-test-"));
const env = { ...process.env, CODE_DUNGEON_DATA: dataDir } as Record<string, string>;
// le conversazioni del test finiscono nel progetto d'esempio: alla fine si tolgono le nuove
const convDir = path.join(project, ".tour", "conversazioni");
const convsBefore = new Set(await fs.readdir(convDir).catch(() => [] as string[]));

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};
const text = (r: any): string => r.content?.map((c: any) => c.text).join("\n") ?? "";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/server/cli.ts", "mcp", "--project", project, "--port", String(PORT)],
  stderr: "pipe",
  env,
});
const client = new Client({ name: "test-agente", version: "0.0.1" });
const pushed: any[] = [];
client.fallbackNotificationHandler = async (n) => {
  if (n.method === "notifications/claude/channel") pushed.push(n.params);
};
await client.connect(transport);
check((client.getServerCapabilities()?.experimental as any)?.["claude/channel"], "il server si dichiara canale di Claude Code");

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("strumenti:", tools.join(", "));
check(tools.includes("highlight_lines") && tools.includes("add_step") && tools.includes("get_user_questions"), "strumenti esposti");

const prompt = await client.getPrompt({ name: "crea_tour", arguments: { flusso: "il login" } });
const promptText = (prompt.messages[0]?.content as { text?: string }).text ?? "";
check(/il login/.test(promptText) && /flusso reale/.test(promptText), "prompt crea_tour con la guida");

// il "gioco"
const game = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const received: any[] = [];
game.on("message", (d) => received.push(JSON.parse(String(d))));
await new Promise((r) => game.once("open", r));
await new Promise((r) => setTimeout(r, 200));
check(received[0]?.type === "hello" && received[0].files.includes("server.py"), "il gioco riceve hello con i file");
check(received[0]?.prefs && !received[0].prefs.settings && !received[0].prefs.reader, "hello porta le preferenze (vuote al primo avvio)");

// connessione da un'origine estranea: deve essere rifiutata
const evil = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: "https://sito-malevolo.example" } });
const evilResult = await new Promise<string>((r) => {
  evil.once("open", () => r("aperta"));
  evil.once("error", () => r("rifiutata"));
});
check(evilResult === "rifiutata", "origine esterna rifiutata");

let r = await client.callTool({ name: "highlight_lines", arguments: { path: "protocol.py", start: 27, end: 35 } });
await new Promise((res) => setTimeout(res, 150));
check(!r.isError && received.some((m) => m.type === "highlight" && m.start === 27), "highlight_lines arriva al gioco");

r = await client.callTool({ name: "open_file", arguments: { path: "../../package.json" } });
check(r.isError && /esce dal progetto/.test(text(r)), "path traversal bloccato");

r = await client.callTool({ name: "highlight_lines", arguments: { path: "server.py", start: 30, end: 999 } });
check(r.isError, "righe fuori dal file rifiutate");

r = await client.callTool({ name: "show_dialog", arguments: { text: "Ciao dal test!", expression: "felice" } });
await new Promise((res) => setTimeout(res, 150));
check(received.some((m) => m.type === "dialog" && m.text === "Ciao dal test!"), "show_dialog arriva al gioco");

// costruzione di un tour
await client.callTool({ name: "create_tour", arguments: { tour_id: TOUR, title: "Prova", overwrite: true } });
r = await client.callTool({
  name: "add_step",
  arguments: { tour_id: TOUR, file: "server.py", start_line: 25, end_line: 33, text: { facile: "Il portone." }, next: [{ goto: "fine" }] },
});
check(!r.isError, "add_step");
r = await client.callTool({ name: "play_tour", arguments: { tour_id: TOUR } });
check(r.isError && /inesistenti/.test(text(r)), "play_tour segnala collegamenti rotti");
await client.callTool({
  name: "add_step",
  arguments: { tour_id: TOUR, step_id: "fine", file: "server.py", start_line: 17, end_line: 19, text: { medio: "Ritorno." }, next: [] },
});
await client.callTool({ name: "set_step_text", arguments: { tour_id: TOUR, step_id: "fine", level: "arduo", text: "Ritorno, ma arduo." } });
r = await client.callTool({ name: "play_tour", arguments: { tour_id: TOUR } });
await new Promise((res) => setTimeout(res, 150));
const played = received.find((m) => m.type === "play_tour");
check(!r.isError && played?.tour.steps.length === 2 && played.tour.steps[1].text.arduo, "play_tour invia il tour completo");

// domanda dall'utente
game.send(JSON.stringify({ type: "question", text: "Cosa fa recv_exact?", context: { level: "arduo", file: "protocol.py", guide: "Aria" } }));
await new Promise((res) => setTimeout(res, 150));
r = await client.callTool({ name: "get_user_questions", arguments: {} });
check(/recv_exact/.test(text(r)) && /arduo/.test(text(r)) && /Aria/.test(text(r)), "get_user_questions restituisce domanda e contesto (con il nome della guida)");
r = await client.callTool({ name: "get_user_questions", arguments: {} });
check(/Nessuna domanda/.test(text(r)), "le domande vengono svuotate");

// domanda spinta all'agente come evento di canale; la risposta con question_id la toglie dalla coda
game.send(JSON.stringify({ type: "question", text: "Perché big-endian?", context: { level: "medio", file: "protocol.py", lines: [27, 35] } }));
await new Promise((res) => setTimeout(res, 150));
const ev = pushed.at(-1);
check(ev?.content === "Perché big-endian?" && ev.meta.question_id && ev.meta.lines === "27-35", "la domanda arriva da sola all'agente (canale)");
await client.callTool({ name: "show_dialog", arguments: { text: "Perché lo dice il protocollo.", question_id: ev?.meta.question_id } });
r = await client.callTool({ name: "get_user_questions", arguments: {} });
check(/Nessuna domanda/.test(text(r)), "show_dialog con question_id segna la domanda come risposta");

// conversazioni: domanda e risposte salvate in .tour/conversazioni/, un seguito porta con sé le precedenti
const convId = ev?.meta.conversation;
await new Promise((res) => setTimeout(res, 150));
r = await client.callTool({ name: "get_conversation", arguments: { id: convId } });
check(convId && /Perché big-endian\?/.test(text(r)) && /lo dice il protocollo/.test(text(r)), "get_conversation restituisce domanda e risposta");
game.send(JSON.stringify({ type: "question", text: "E little-endian?", context: { level: "medio" }, conversation: convId }));
await new Promise((res) => setTimeout(res, 150));
const ev2 = pushed.at(-1);
check(ev2?.meta.conversation === convId && /E little-endian\?/.test(ev2.content) && /lo dice il protocollo/.test(ev2.content), "il seguito arriva all'agente con le risposte precedenti");
await client.callTool({ name: "show_dialog", arguments: { text: "Sarebbe al contrario.", question_id: ev2?.meta.question_id } });
await new Promise((res) => setTimeout(res, 150));
check(received.some((m) => m.type === "conversation" && m.summary.id === convId && m.summary.turns === 2), "il gioco viene avvisato della conversazione aggiornata");
game.send(JSON.stringify({ type: "request", reqId: "c1", op: "load_conversation", id: convId }));
game.send(JSON.stringify({ type: "request", reqId: "c2", op: "load_conversation", id: "../../package" }));
await new Promise((res) => setTimeout(res, 150));
const loaded = received.find((m) => m.reqId === "c1")?.data;
check(loaded?.turns?.[1]?.answers?.[0]?.text === "Sarebbe al contrario." && loaded.turns[0].code === undefined, "il gioco rilegge la conversazione");
check(received.find((m) => m.reqId === "c2")?.ok === false, "id della conversazione fuori dal progetto rifiutato");

// agente in ascolto: wait_for_question si sblocca alla domanda, che non viene anche spinta
const before = pushed.length;
const waiting = client.callTool({ name: "wait_for_question", arguments: { timeout_seconds: 30 } });
await new Promise((res) => setTimeout(res, 150));
game.send(JSON.stringify({ type: "question", text: "E il timeout?", context: { level: "facile" } }));
r = await waiting;
check(/E il timeout\?/.test(text(r)) && pushed.length === before, "wait_for_question riceve la domanda appena scritta");
r = await client.callTool({ name: "wait_for_question", arguments: { timeout_seconds: 5 } });
check(/Nessuna domanda nel frattempo/.test(text(r)), "wait_for_question finisce allo scadere del tempo");
r = await client.callTool({ name: "get_user_questions", arguments: {} });
check(/E il timeout\?/.test(text(r)), "una domanda consegnata ma senza risposta resta per get_user_questions");

// gioco aperto o ricaricato in ritardo: riceve la scena, non solo l'ultimo comando
const lateGame = async (): Promise<any[]> => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const got: any[] = [];
  ws.on("message", (d) => got.push(JSON.parse(String(d))));
  await new Promise((res) => setTimeout(res, 250));
  ws.close();
  return got.filter((m) => m.type !== "conversation").map((m) => m.type === "play_tour" ? `play_tour:${m.fromStep ?? ""}` : m.type);
};
await client.callTool({ name: "highlight_lines", arguments: { path: "protocol.py", start: 27, end: 35 } });
await client.callTool({ name: "show_dialog", arguments: { text: "Risposta dal vivo." } });
game.send(JSON.stringify({ type: "state", context: { level: "medio", tourId: TOUR, stepId: "fine", live: true } }));
await new Promise((res) => setTimeout(res, 150));
let late = await lateGame();
check(late.join(",") === "hello,play_tour:fine,highlight,dialog", "chi arriva tardi riceve tour dal passo corrente, codice e risposta");
game.send(JSON.stringify({ type: "state", context: { level: "medio", tourId: TOUR, stepId: "fine", live: false } }));
await new Promise((res) => setTimeout(res, 150));
late = await lateGame();
check(late.join(",") === "hello,play_tour:fine", "la risposta già chiusa non viene ripetuta");

// porta occupata: un secondo server sceglie la successiva libera
const second = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/server/cli.ts", "mcp", "--project", project, "--port", String(PORT)],
  stderr: "pipe",
  env,
});
const client2 = new Client({ name: "test-agente-2", version: "0.0.1" });
await client2.connect(second);
r = await client2.callTool({ name: "get_game_state", arguments: {} });
check(text(r).includes(`127.0.0.1:${PORT + 1}`), "con la porta occupata il secondo server usa la successiva");

// questionario: salvato in SQLite, condiviso tra server, passato all'agente
const other = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const otherGot: any[] = [];
other.on("message", (d) => otherGot.push(JSON.parse(String(d))));
await new Promise((res) => other.once("open", res));
game.send(
  JSON.stringify({
    type: "save_prefs",
    prefs: { settings: { level: "facile", lang: "it" }, reader: { aids: ["frasi_brevi", "piu_schemi", "inventato"], note: "x".repeat(400) } },
  }),
);
await new Promise((res) => setTimeout(res, 200));
const synced = otherGot.find((m) => m.type === "prefs");
check(synced?.prefs.reader.aids.join() === "frasi_brevi,piu_schemi" && synced.prefs.reader.note.length === 300, "save_prefs pulisce le risposte e allinea le altre finestre");
check(!received.some((m) => m.type === "prefs"), "chi salva non riceve l'eco");
other.close();
r = await client.callTool({ name: "get_game_state", arguments: {} });
check(/Chi legge ha chiesto: frasi brevi/.test(text(r)) && /"piu_schemi"/.test(text(r)), "get_game_state riporta le preferenze di chi legge");
check(/Lingua scelta nel gioco: italiano/.test(text(r)) && /"lang": "it"/.test(text(r)), "get_game_state riporta la lingua scelta");
const ws2 = new WebSocket(`ws://127.0.0.1:${PORT + 1}/ws`);
const hello2 = await new Promise<any>((res) => ws2.once("message", (d) => res(JSON.parse(String(d)))));
ws2.close();
check(hello2.prefs?.settings?.level === "facile" && hello2.prefs.reader?.aids.includes("piu_schemi"), "le preferenze valgono anche per un altro server (stesso database)");
await client2.close();

game.send(JSON.stringify({ type: "question", text: "Spiegami il login", context: { level: "facile" } }));
await new Promise((res) => setTimeout(res, 150));
check(/lavagna/.test(pushed.at(-1)?.meta?.aiuti ?? ""), "la domanda spinta porta gli aiuti di chi legge");
r = await client.callTool({ name: "get_user_questions", arguments: {} });
check(/Chi legge ha chiesto/.test(text(r)), "get_user_questions ricorda gli aiuti");

// lavagna degli schemi
const SCHEMA = "prova-schema";
const nodes = [
  { id: "a", label: "Arrivo", code: { file: "server.py", start: 12, end: 22 } },
  { id: "b", label: "Tipo?", shape: "bivio" },
  { id: "c", label: "Login" },
];
r = await client.callTool({
  name: "draw_diagram",
  arguments: { diagram_id: SCHEMA, title: "Prova", kind: "flusso", nodes, edges: [{ from: "a", to: "x" }] },
});
check(r.isError && /inesistenti: x/.test(text(r)), "draw_diagram rifiuta archi verso nodi inesistenti");
r = await client.callTool({
  name: "draw_diagram",
  arguments: { diagram_id: SCHEMA, title: "Prova", kind: "flusso", nodes: [{ id: "a", label: "A", code: { file: "server.py", start: 1, end: 999 } }], edges: [] },
});
check(r.isError, "draw_diagram controlla le righe del codice");
r = await client.callTool({
  name: "draw_diagram",
  arguments: { diagram_id: SCHEMA, title: "Prova", kind: "flusso", nodes, edges: [{ from: "a", to: "b" }, { from: "b", to: "c", label: "LOGIN" }], upto: 1, overwrite: true },
});
await new Promise((res) => setTimeout(res, 150));
const drawn = received.find((m) => m.type === "diagram");
check(!r.isError && drawn?.diagram.nodes[0].code.lines[1] === 22 && drawn.upto === 1, "draw_diagram salva e invia lo schema");
r = await client.callTool({ name: "reveal_diagram", arguments: { diagram_id: SCHEMA, upto: 3 } });
await new Promise((res) => setTimeout(res, 150));
check(!r.isError && received.filter((m) => m.type === "diagram").at(-1)?.upto === 3, "reveal_diagram mostra altri pezzi");
r = await client.callTool({ name: "set_step_diagram", arguments: { tour_id: TOUR, step_id: "fine", diagram_id: SCHEMA, upto: 9 } });
check(r.isError && /3 pezzi/.test(text(r)), "set_step_diagram controlla upto");
r = await client.callTool({ name: "set_step_diagram", arguments: { tour_id: TOUR, step_id: "fine", diagram_id: SCHEMA, upto: 2 } });
r = await client.callTool({ name: "get_tour", arguments: { tour_id: TOUR } });
check(/prova-schema/.test(text(r)), "set_step_diagram collega lo schema al passo");
await fs.rm(path.join(project, ".tour", "schemi", `${SCHEMA}.json`), { force: true });

await fs.rm(path.join(project, ".tour", `${TOUR}.json`), { force: true });
for (const name of await fs.readdir(convDir).catch(() => [] as string[])) {
  if (!convsBefore.has(name)) await fs.rm(path.join(convDir, name), { force: true });
}
if (convsBefore.size === 0) await fs.rm(convDir, { recursive: true, force: true });
game.close();
evil.close();
await client.close();
await fs.rm(dataDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} controlli falliti` : "\nTutti i controlli passati.");
process.exit(failures ? 1 : 0);
