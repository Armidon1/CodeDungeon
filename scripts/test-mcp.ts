// Prova end-to-end: avvia il server MCP sul progetto d'esempio, si collega come un agente
// (client MCP su stdio) e come il gioco (WebSocket), e verifica che i comandi arrivino.
//   npm run test:mcp

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

const PORT = 7400 + Math.floor(Math.random() * 500); // porta casuale: evita conflitti con esecuzioni precedenti
const project = path.resolve("examples/packet-server");
const TOUR = "prova-automatica";

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
});
const client = new Client({ name: "test-agente", version: "0.0.1" });
await client.connect(transport);

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
game.send(JSON.stringify({ type: "question", text: "Cosa fa recv_exact?", context: { level: "arduo", file: "protocol.py" } }));
await new Promise((res) => setTimeout(res, 150));
r = await client.callTool({ name: "get_user_questions", arguments: {} });
check(/recv_exact/.test(text(r)) && /arduo/.test(text(r)), "get_user_questions restituisce domanda e contesto");
r = await client.callTool({ name: "get_user_questions", arguments: {} });
check(/Nessuna domanda/.test(text(r)), "le domande vengono svuotate");

// gioco aperto o ricaricato in ritardo: riceve la scena, non solo l'ultimo comando
const lateGame = async (): Promise<any[]> => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const got: any[] = [];
  ws.on("message", (d) => got.push(JSON.parse(String(d))));
  await new Promise((res) => setTimeout(res, 250));
  ws.close();
  return got.map((m) => m.type === "play_tour" ? `play_tour:${m.fromStep ?? ""}` : m.type);
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

await fs.rm(path.join(project, ".tour", `${TOUR}.json`), { force: true });
game.close();
evil.close();
await client.close();
console.log(failures ? `\n${failures} controlli falliti` : "\nTutti i controlli passati.");
process.exit(failures ? 1 : 0);
