// Prova end-to-end: avvia il server MCP sul progetto d'esempio, si collega come un agente
// (client MCP su stdio) e come il gioco (WebSocket), e verifica che i comandi arrivino.
//   npm run test:mcp

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { Project, conversationSummary } from "../src/server/project";
import { numberSpan, type Conversation } from "../src/shared/types";

const PORT = 7400 + Math.floor(Math.random() * 500); // porta casuale: evita conflitti con esecuzioni precedenti
const TOUR = "prova-automatica";
// preferenze in una cartella temporanea: il test non tocca quelle dell'utente
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-dungeon-test-"));
const project = path.join(dataDir, "packet-server");
await fs.cp(path.resolve("examples/packet-server"), project, { recursive: true });
// finta cartella di Claude Code: questo processo fa da "claude" e la sua chat ha un titolo
const claudeDir = path.join(dataDir, "claude");
const fakeSession = "test-sessione-1234";
await fs.mkdir(path.join(claudeDir, "sessions"), { recursive: true });
await fs.mkdir(path.join(claudeDir, "projects", "-progetto"), { recursive: true });
await fs.writeFile(path.join(claudeDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: fakeSession, cwd: "/progetto" }));
await fs.writeFile(
  path.join(claudeDir, "projects", "-progetto", `${fakeSession}.jsonl`),
  ['{"type":"user","message":"ciao"}', '{"type":"ai-title","aiTitle":"Titolo vecchio","sessionId":"x"}', '{"type":"ai-title","aiTitle":"Cartelle e \\"terminale\\"","sessionId":"x"}', ""].join("\n"),
);
const env = { ...process.env, CODE_DUNGEON_DATA: dataDir, CLAUDE_CONFIG_DIR: claudeDir } as Record<string, string>;

// Le prove lavorano sulla copia temporanea del progetto.
const convDir = path.join(project, ".tour", "conversazioni");
const gapsFile = path.join(project, ".tour", "lacune.json");
await fs.rm(gapsFile, { force: true });

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};
// righe numerate per l'agente: un estratto di più righe solo se coincide con l'intervallo
check(numberSpan("a\nb\n", [9, 10]) === " 9│ a\n10│ b", "un estratto di righe 9-10 arriva numerato");
check(numberSpan("a\nb", [9, 11]) === undefined && numberSpan("a", [9, 9]) === undefined, "estratti di una riga o con righe diverse dall'intervallo restano come sono");
// spostare un file (gioco in tutor): resta nel progetto e non sovrascrive
{
  const box = path.join(dataDir, "sposta");
  await fs.mkdir(path.join(box, "dir"), { recursive: true });
  await fs.mkdir(path.join(box, ".tour"), { recursive: true });
  await fs.writeFile(path.join(box, "a.py"), "a\n");
  await fs.writeFile(path.join(box, "dir", "b.py"), "b\n");
  await fs.writeFile(path.join(box, "b.py"), "altro\n");
  const p = new Project(box);
  const fails = (f: () => Promise<unknown>) => f().then(() => false, () => true);
  const moved = await p.moveFile("a.py", "dir");
  check(moved === "dir/a.py" && (await fs.readFile(path.join(box, "dir", "a.py"), "utf8")) === "a\n", "moveFile sposta un file in una cartella");
  const guard =
    (await fails(() => p.moveFile("b.py", "dir"))) && (await fs.readFile(path.join(box, "dir", "b.py"), "utf8")) === "b\n" &&
    (await fails(() => p.moveFile("dir/a.py", ".."))) && (await fails(() => p.moveFile("dir/a.py", ".tour"))) && (await fails(() => p.moveFile("dir", "")));
  check(guard, "moveFile non sovrascrive, non esce dal progetto, non entra in .tour/, non sposta cartelle");
  await fs.mkdir(path.join(box, ".git"));
  await fs.writeFile(path.join(box, ".tour", "tour.json"), "{}");
  await fs.writeFile(path.join(box, ".git", "config"), "");
  await fs.symlink("b.py", path.join(box, "alias.py"), "file");
  await fs.symlink(project, path.join(box, "fuori"), "junction");
  await fs.mkdir(path.join(box, "dir", "vuota"));
  await fs.mkdir(path.join(box, "meta", "dir"), { recursive: true });
  await fs.symlink(path.join(box, "dir"), path.join(box, "alias-dir"), "junction");
  check(await fails(() => p.moveFile("alias.py", "meta")) && await fails(() => p.moveFile("dir/a.py", "alias-dir")) &&
    (await p.readFile("b.py")) === "altro\n", "moveFile protegge lo spostamento di ritorno se un percorso è diventato un link");
  check((await Promise.all([
    ["", "meta"], ["dir", "dir"], ["dir", "dir/vuota"], ["dir", "meta"], ["b.py", "meta"],
    ["dir", ".."], ["dir", "fuori"], ["dir", ".git"], [".tour", "meta"], ["alias-dir", "meta"],
  ].map(([from, to]) => fails(() => p.moveDirectory(from, to))))).every(Boolean) &&
    (await fs.readdir(path.join(box, "meta", "dir"))).length === 0 && (await p.readFile("dir/a.py")) === "a\n",
  "moveDirectory rifiuta cicli, collisioni con cartelle vuote, link e percorsi protetti");
  await fs.rmdir(path.join(box, "meta", "dir"));
  check((await p.moveDirectory("dir", "meta")).to === "meta/dir" &&
    (await p.listTree()).dirs.includes("meta/dir/vuota") && (await p.readFile("meta/dir/a.py")) === "a\n" &&
    (await p.moveDirectory("meta/dir", "")).to === "dir", "moveDirectory porta con sé file e sottocartelle vuote e può tornare alla radice");
  for (const folder of ["primo", "secondo"]) await fs.mkdir(path.join(box, folder, "condivisa"), { recursive: true });
  const moves = await Promise.allSettled([p.moveDirectory("primo/condivisa", "meta"), p.moveDirectory("secondo/condivisa", "meta")]);
  check(moves.filter((move) => move.status === "fulfilled").length === 1 &&
    (await p.listTree()).dirs.filter((dir) => dir.endsWith("/condivisa")).length === 2,
  "due spostamenti concorrenti verso lo stesso nome conservano entrambe le cartelle");
  const protectedFiles = ["dir", "../packet-server/server.py", ".tour/tour.json", ".git/config", "alias.py", "fuori/server.py"];
  const invalidNames = ["", ".", "..", "../lib.py", "sub/file.py", ".git", ".tour", "file."];
  check((await Promise.all([
    ...invalidNames.map((name) => fails(() => p.renameFile("dir/a.py", name))),
    ...protectedFiles.map((file) => fails(() => p.renameFile(file, "lib.py"))),
    fails(() => p.renameFile("dir/a.py", "b.py")),
  ])).every(Boolean) && (await fs.readFile(path.join(box, "dir", "b.py"), "utf8")) === "b\n",
  "renameFile rifiuta destinazioni occupate, nomi non validi e file protetti");
  check(await p.renameFile("dir/a.py", "A.py") === "dir/A.py" &&
    (await p.listFiles()).includes("dir/A.py") && !(await p.listFiles()).includes("dir/a.py") &&
    (await fs.readFile(path.join(box, "dir", "A.py"), "utf8")) === "a\n", "renameFile può cambiare le maiuscole, nella stessa cartella e con lo stesso contenuto");
  await p.renameFile("dir/A.py", "a.py");
  check((await Promise.all(protectedFiles.map((file) => fails(() => p.deleteFile(file))))).every(Boolean) &&
    (await fs.readFile(path.join(box, "b.py"), "utf8")) === "altro\n", "deleteFile rifiuta cartelle, link simbolici, percorsi esterni e metadati protetti");
  check((await p.deleteFile("dir/a.py")) === "dir/a.py" &&
    !(await p.listFiles()).includes("dir/a.py") &&
    (await p.listFiles()).includes("dir/b.py"), "il cestino toglie dall'albero solo il file richiesto");
  const reopened = new Project(box);
  const [entry] = await reopened.listTrash();
  check(entry?.path === "dir/a.py" && !(await reopened.listFiles()).some((file) => file.includes("cestino")),
    "il cestino persiste nel progetto e resta fuori dall'albero");
  check(await reopened.createEntry("dir", "a.py", "file") === "dir/a.py" &&
    await fails(() => reopened.restoreFile(entry.id)) && (await reopened.readFile("dir/a.py")) === "" &&
    (await reopened.listTrash()).some((item) => item.id === entry.id), "Ripristina lascia intatto un file nuovo con lo stesso percorso");
  await fs.unlink(path.join(box, "dir", "a.py"));
  check(await reopened.restoreFile(entry.id) === "dir/a.py" &&
    (await reopened.readFile("dir/a.py")) === "a\n" && (await reopened.listTrash()).length === 0, "Ripristina recupera il contenuto e toglie la voce dal cestino");
  check(await p.createEntry("", "vuota", "dir") === "vuota" &&
    (await p.listTree()).dirs.includes("vuota") && !(await p.listFiles()).includes("vuota"), "l'albero include le cartelle vuote, separate dai file");
  const creates = await Promise.allSettled([p.createEntry("vuota", "nuovo.py", "file"), p.createEntry("vuota", "nuovo.py", "file")]);
  check(creates.filter((create) => create.status === "fulfilled").length === 1 &&
    (await Promise.all(["..", "fuori", ".tour", ".git"].map((dir) => fails(() => p.createEntry(dir, "nuovo.py", "file"))))).every(Boolean),
    "la creazione è esclusiva e rispetta i confini del progetto");
  await p.deleteFile("vuota/nuovo.py");
  const [orphan] = await p.listTrash();
  await fs.rmdir(path.join(box, "vuota"));
  check(await p.restoreFile(orphan.id) === "vuota/nuovo.py" && (await p.readFile("vuota/nuovo.py")) === "", "il ripristino ricrea la cartella originale");
  const linked = path.join(dataDir, "cestino-con-link");
  await fs.mkdir(linked);
  await fs.writeFile(path.join(linked, "origine.py"), "intatto\n");
  await fs.symlink(project, path.join(linked, ".tour"), "junction");
  check(await fails(() => new Project(linked).deleteFile("origine.py")) &&
    (await fs.readFile(path.join(linked, "origine.py"), "utf8")) === "intatto\n", "un link esterno sotto .tour non riceve file del cestino");
}
const text = (r: any): string => r.content?.map((c: any) => c.text).join("\n") ?? "";
const png = { mimeType: "image/png", data: (await fs.readFile("src-tauri/icons/32x32.png")).toString("base64") };
const largerPng = { mimeType: "image/png", data: (await fs.readFile("src-tauri/icons/64x64.png")).toString("base64") };
let imageRequestId = 0;
const askWithImages = (socket: WebSocket, submission: object): Promise<any> => new Promise((resolve, reject) => {
  const reqId = `image-${++imageRequestId}`;
  const receive = (data: WebSocket.RawData) => {
    const reply = JSON.parse(String(data));
    if (reply.reqId !== reqId) return;
    clearTimeout(timer);
    socket.off("message", receive);
    resolve(reply);
  };
  const timer = setTimeout(() => {
    socket.off("message", receive);
    reject(new Error("Il ponte non ha confermato la domanda con immagini."));
  }, 5000);
  socket.on("message", receive);
  socket.send(JSON.stringify({ type: "request", reqId, op: "ask_with_images", ...submission }));
});

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/server/cli.ts", "mcp", "--project", project, "--port", String(PORT)],
  stderr: "pipe",
  env,
});
// il primo agente apre con initialize: il ripiego sul protocollo 2025 (quello che usa il canale di Claude Code)
const client = new Client({ name: "test-agente", version: "0.0.1" });
const pushed: any[] = [];
client.fallbackNotificationHandler = async (n) => {
  if (n.method === "notifications/claude/channel") pushed.push(n.params);
};
await client.connect(transport);
check(client.getProtocolEra() === "legacy", "un client 2025 viene servito col protocollo 2025");
check((client.getServerCapabilities()?.experimental as any)?.["claude/channel"], "il server si dichiara canale di Claude Code");

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check(
  /non costruire un tour/.test(client.getInstructions() ?? "") && /Costruisci un tour solo se lo chiede/.test(client.getInstructions() ?? ""),
  "le istruzioni dicono di aprire il gioco senza tour, a meno che l'utente non lo chieda",
);
console.log("strumenti:", tools.join(", "));
check(tools.includes("highlight_lines") && tools.includes("mark_lines") && tools.includes("add_step") && tools.includes("get_user_questions"), "strumenti esposti");

const prompt = await client.getPrompt({ name: "crea_tour", arguments: { flusso: "il login" } });
const promptText = (prompt.messages[0]?.content as { text?: string }).text ?? "";
check(/il login/.test(promptText) && /flusso reale/.test(promptText), "prompt crea_tour con la guida");
const tutorPrompt = await client.getPrompt({ name: "tutor", arguments: {} });
const tutorText = (tutorPrompt.messages[0]?.content as { text?: string }).text ?? "";
check(/modalità tutor/.test(tutorText) && /Non scrivere la soluzione/.test(tutorText), "prompt tutor con le regole (protocollo 2025)");

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

// /session: il gioco elenca le sessioni aperte; un sito estraneo non le vede
const sessionUrl = `http://127.0.0.1:${PORT}/session`;
const session = await fetch(sessionUrl, { headers: { origin: "http://tauri.localhost" } });
const info = (await session.json()) as { project?: string; agent?: boolean; port?: number; folder?: string; started?: number; chat?: string };
check(
  session.ok && info.project === "packet-server" && info.agent === true && info.port === PORT &&
    !!info.folder?.endsWith("packet-server") && typeof info.started === "number" &&
    session.headers.get("access-control-allow-origin") === "http://tauri.localhost",
  "/session descrive la sessione all'app",
);
const evilSession = await fetch(sessionUrl, { headers: { origin: "https://sito-malevolo.example" } });
check(info.chat === 'Cartelle e "terminale"', `/session dà il titolo della chat di Claude Code (${info.chat})`);
check(evilSession.status === 403, "/session rifiuta le origini esterne");

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
check(received.some((m) => m.type === "conversation" && m.summary.id === convId && m.summary.turns === 2 && Array.isArray(m.summary.diagrams)), "il gioco viene avvisato della conversazione aggiornata");
{
  const q = (id: string) => ({ id, text: id, askedAt: "", context: {} });
  const sum = conversationSummary({
    version: 1, id: "x", title: "x", startedAt: "", updatedAt: "",
    turns: [{ question: q("a"), answers: [], diagram: { id: "strati" } }, { question: q("b"), answers: [] }, { question: q("c"), answers: [], diagram: { id: "strati", upto: 2 } }, { question: q("d"), answers: [], diagram: { id: "header" } }],
  } as Conversation);
  check(sum.diagrams.join() === "strati,header", "il riassunto della conversazione elenca i suoi schemi senza doppioni");
}
game.send(JSON.stringify({ type: "request", reqId: "c1", op: "load_conversation", id: convId }));
game.send(JSON.stringify({ type: "request", reqId: "c2", op: "load_conversation", id: "../../package" }));
await new Promise((res) => setTimeout(res, 150));
const loaded = received.find((m) => m.reqId === "c1")?.data;
check(loaded?.turns?.[1]?.answers?.[0]?.text === "Sarebbe al contrario." && loaded.turns[0].code === undefined, "il gioco rilegge la conversazione");
check(received.find((m) => m.reqId === "c2")?.ok === false, "id della conversazione fuori dal progetto rifiutato");

game.send(JSON.stringify({ type: "question", text: "Ancora?", context: { level: "medio" }, conversation: convId }));
await new Promise((res) => setTimeout(res, 150));
const followUp = pushed.at(-1);
check(followUp.content.includes("Sarebbe al contrario.") && !followUp.content.includes("lo dice il protocollo"), "il seguito include solo l'ultimo scambio");
r = await client.callTool({ name: "show_dialog", arguments: { question_id: followUp.meta.question_id, text: "Qui.", highlight: { path: "protocol.py", start: 1, end: 9999 } } });
check(r.isError, "una risposta con righe non valide può essere ritentata");
r = await client.callTool({ name: "show_dialog", arguments: { question_id: followUp.meta.question_id, text: "Qui.", highlight: { path: "protocol.py", start: 1, end: 3 } } });
r = await client.callTool({ name: "get_conversation", arguments: { id: convId } });
const turns = JSON.parse(text(r).slice(text(r).indexOf("{"))).turns;
check(turns[2].code.lines.join() === "1,3" && turns[2].answers.length === 1 && turns[0].answers.length === 1, "fumetto e righe registrati insieme nel turno giusto, storico completo");

// domanda su un testo selezionato: la selezione arriva all'agente insieme alla domanda
const selection = "ptype, payload = read_packet(conn)";
game.send(
  JSON.stringify({ type: "question", text: "Cosa fa questo?", context: { level: "medio", file: "server.py", lines: [17, 17], selection: selection + "x".repeat(3000) } }),
);
await new Promise((res) => setTimeout(res, 150));
const ev3 = pushed.at(-1);
check(
  /^Cosa fa questo\?/.test(ev3?.content) && ev3.content.includes(`(server.py, righe 17-17):\n«${selection}`) && ev3.content.length < 2200,
  "la domanda porta il testo selezionato (tagliato se troppo lungo)",
);
await client.callTool({ name: "show_dialog", arguments: { text: "Legge un pacchetto.", question_id: ev3?.meta.question_id } });

// domanda in tutor: codice dell'editor (anche non salvato), righe cambiate e output arrivano all'agente con le regole
const prefix = "# esempio\n".repeat(2500);
const code = 'def solve():\n    print("ciao"\n';
const draft = prefix + code + "#".repeat(5000);
game.send(
  JSON.stringify({
    type: "question",
    text: "Spiegami l'errore",
    context: {
      level: "medio",
      file: "solve.py",
      mode: "tutor",
      buffer: { file: "solve.py", content: draft, dirty: true },
      changed: [[2502, 2502], [0, 3], "x"],
      output: "SyntaxError: '(' was never closed",
    },
  }),
);
await new Promise((res) => setTimeout(res, 150));
const ev4 = pushed.at(-1);
check(
  ev4?.meta.mode === "tutor" && ev4.content.includes("dalla riga 2499 di 2503") && ev4.content.includes('2501│ def solve():\n2502│     print("ciao"\n2503│ #') &&
    /Righe cambiate dall'ultima domanda: 2502/.test(ev4.content) && /SyntaxError/.test(ev4.content) &&
    !ev4.content.includes("Non scrivere la soluzione") && ev4.content.length < 2200,
  "il canale include le modifiche oltre il vecchio limite con un estratto e un richiamo breve",
);
r = await client.callTool({ name: "get_user_questions", arguments: {} });
check(text(r).length < 3000 && text(r).includes('"startLine": 2499') && text(r).includes('2502│     print('), "la coda consegna lo stesso estratto con i numeri di riga");
r = await client.callTool({ name: "read_tutor_buffer", arguments: { question_id: ev4.meta.question_id, start: 1, end: 1 } });
check(text(r).endsWith("# esempio"), "il buffer non salvato resta leggibile dopo il consumo della coda");
r = await client.callTool({ name: "read_tutor_buffer", arguments: { question_id: ev4.meta.question_id, start: 2503, end: 2503, offset: 4000 } });
// la riga numerata è "2503│ " seguito da 5000 #: dall'offset 4000 restano 1006 caratteri
check(text(r).endsWith("\n" + "#".repeat(1006)), "si può leggere anche la fine di una riga lunga");
r = await client.callTool({ name: "read_tutor_buffer", arguments: { question_id: ev4.meta.question_id, start: 2501, end: 2502 } });
check(text(r).endsWith('\n2501│ def solve():\n2502│     print("ciao"'), "read_tutor_buffer dà le righe con il loro numero");
r = await client.callTool({ name: "get_game_state", arguments: {} });
check(/"mode": "tutor"/.test(text(r)) && !/print\(/.test(text(r)), "lo stato del gioco non si porta dietro il codice della domanda");
// mark_lines: ondina e commento sulle righe, con il testo del file a cui si riferiscono; righe fuori dal file rifiutate
r = await client.callTool({ name: "mark_lines", arguments: { path: "protocol.py", marks: [{ line: 30, endLine: 31, kind: "error", message: "Quante parentesi apri?" }, { line: 32, kind: "hint", message: "Ripassa i cicli." }], question_id: ev4?.meta.question_id } });
const marksMsg = received.findLast((m) => m.type === "marks");
check(
  !r.isError && marksMsg?.type === "marks" && marksMsg.path === "protocol.py" && marksMsg.marks.length === 2 && marksMsg.marks[0].endLine === 31 && marksMsg.content.length > 0,
  "mark_lines arriva al gioco con i segni e il testo del file",
);
r = await client.callTool({ name: "mark_lines", arguments: { path: "protocol.py", marks: [{ line: 9999, kind: "warning", message: "x" }] } });
check(r.isError, "mark_lines rifiuta righe fuori dal file");
await client.callTool({ name: "show_dialog", arguments: { text: "Guarda le parentesi della riga 2.", question_id: ev4?.meta.question_id } });
const tutorConv = JSON.parse(await fs.readFile(path.join(convDir, `${ev4?.meta.conversation}.json`), "utf8")) as Conversation;
const savedBuffer = tutorConv.turns[0]?.question.context.buffer;
check(savedBuffer?.file === "solve.py" && savedBuffer.dirty && savedBuffer.content === "", "la conversazione salvata non duplica il codice dell'editor");
check(tutorConv.turns[0]?.marks?.file === "protocol.py" && tutorConv.turns[0].marks.marks.length === 2, "i segni restano nella conversazione");
// registro delle lacune: lo stesso concetto (maiuscole e accenti a parte) conta due volte, il gioco riceve l'elenco
r = await client.callTool({ name: "get_gaps", arguments: {} });
check(!r.isError && /Nessuna lacuna/.test(text(r)), "get_gaps con registro vuoto");
r = await client.callTool({ name: "record_gap", arguments: { concept: "Indici delle liste", example: "lista[len(lista)]" } });
check(!r.isError && /prima volta/.test(text(r)), "record_gap annota una lacuna nuova");
r = await client.callTool({ name: "record_gap", arguments: { concept: "indici  delle LISTE", example: "lista[3] su 3 elementi" } });
check(/2 volte/.test(text(r)), "record_gap riconosce lo stesso concetto");
await client.callTool({ name: "record_gap", arguments: { concept: "Parentesi chiuse" } });
const gapsMsg = received.findLast((m) => m.type === "gaps");
check(gapsMsg?.gaps.length === 2 && gapsMsg.gaps[0].count === 2 && gapsMsg.gaps[0].example === "lista[3] su 3 elementi", "il gioco riceve le lacune, le più frequenti prima");
const savedGaps = JSON.parse(await fs.readFile(gapsFile, "utf8"));
check(savedGaps.version === 1 && savedGaps.items.length === 2, "le lacune restano in .tour/lacune.json");
game.send(JSON.stringify({ type: "request", reqId: "g1", op: "resolve_gap", id: gapsMsg?.gaps[0].id, resolved: true }));
await new Promise((res) => setTimeout(res, 150));
const afterResolve = received.find((m) => m.reqId === "g1")?.data;
check(afterResolve?.[0]?.concept === "Parentesi chiuse" && afterResolve[1].resolved, "una lacuna risolta va in fondo");
r = await client.callTool({ name: "get_gaps", arguments: {} });
check(/1 da ripassare, 1 risolte/.test(text(r)), "get_gaps conta risolte e da ripassare");
r = await client.callTool({ name: "record_gap", arguments: { concept: "Indici delle liste" } });
check(/3 volte/.test(text(r)), "un errore ripetuto si conta ancora");
r = await client.callTool({ name: "get_gaps", arguments: {} });
check(/2 da ripassare, 0 risolte/.test(text(r)), "la lacuna riaperta torna da ripassare");

// in flusso i campi del tutor vengono tolti
game.send(JSON.stringify({ type: "question", text: "E qui?", context: { level: "medio", buffer: { file: "a.py", content: "segreto", dirty: false }, output: "x" } }));
await new Promise((res) => setTimeout(res, 150));
const ev5 = pushed.at(-1);
check(ev5?.content === "E qui?" && !ev5.meta.mode, "fuori dal tutor buffer e output non passano");
await client.callTool({ name: "show_dialog", arguments: { text: "Ok.", question_id: ev5?.meta.question_id } });

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

// Il gioco invia mentre il client non è ancora in attesa. La notifica non è una conferma di lettura.
const queuedText = "Cosa significa len?";
const nextMessage = (matches: (msg: any) => boolean, socket = game) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.off("message", onMessage);
    reject(new Error("Messaggio del gioco non ricevuto entro 5 s."));
  }, 5000);
  const onMessage = (data: Buffer) => {
    if (!matches(JSON.parse(String(data)))) return;
    clearTimeout(timer);
    socket.off("message", onMessage);
    resolve();
  };
  socket.on("message", onMessage);
});
const queuedEvent = nextMessage(msg => msg.type === "conversation" && msg.summary.title === queuedText);
game.send(JSON.stringify({ type: "question", text: queuedText, context: { mode: "tutor", level: "facile", lang: "it" } }));
await queuedEvent;
const waitStarted = performance.now();
r = await client.callTool({ name: "wait_for_question", arguments: { timeout_seconds: 5 } });
check(text(r).includes(queuedText), "la prima attesa dopo la notifica recupera la domanda già in coda");
if (text(r).includes(queuedText)) {
  const [queued] = JSON.parse(text(r).slice(text(r).indexOf("\n")));
  const deliveredAt = performance.now();
  const reply = "len restituisce il numero di elementi.";
  const shown = nextMessage(msg => msg.type === "dialog" && msg.text === reply);
  await Promise.all([shown, client.callTool({ name: "show_dialog", arguments: { question_id: queued.id, text: reply } })]);
  console.log(`Ponte locale, risposta prefissata: attesa → domanda ${(deliveredAt - waitStarted).toFixed(1)} ms, risposta → gioco ${(performance.now() - deliveredAt).toFixed(1)} ms.`);
  r = await client.callTool({ name: "get_user_questions", arguments: {} });
  check(/Nessuna domanda/.test(text(r)), "la risposta diretta svuota la coda");
}

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
// il secondo agente parla solo MCP 2026-07-28: niente initialize, versione nel _meta di ogni richiesta
const client2 = new Client({ name: "test-agente-2", version: "0.0.1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
await client2.connect(second);
check(client2.getProtocolEra() === "modern", "un client 2026-07-28 viene servito senza handshake");
check((await client2.listTools()).tools.some((t) => t.name === "wait_for_question"), "strumenti esposti anche col protocollo 2026-07-28");
check((await client2.listPrompts()).prompts.some((p) => p.name === "tutor"), "prompt tutor esposto anche col protocollo 2026-07-28");
r = await client2.callTool({ name: "get_game_state", arguments: {} });
// la successiva libera: di solito PORT + 1, ma sul runner della CI può essere già presa da altro
const PORT2 = Number(/127\.0\.0\.1:(\d+)/.exec(text(r))?.[1]);
const info2 = PORT2 ? await (await fetch(`http://127.0.0.1:${PORT2}/session`)).json().catch(() => undefined) : undefined;
check(
  PORT2 > PORT && PORT2 < PORT + 20 && info2?.port === PORT2 && info2.project === "packet-server",
  `con la porta occupata il secondo server usa la successiva libera${PORT2 > PORT ? "" : ` (porta ${PORT}, risposta: ${text(r).slice(0, 200)})`}`,
);
// il titolo della chat va nell'elenco delle sessioni, solo per la sessione che lo dà
r = await client2.callTool({ name: "name_session", arguments: { title: "Buffer overflow in vuln.c" } });
const named2 = PORT2 ? await (await fetch(`http://127.0.0.1:${PORT2}/session`)).json().catch(() => undefined) : undefined;
const named1 = await (await fetch(sessionUrl)).json();
check(
  !r.isError && named2?.title === "Buffer overflow in vuln.c" && typeof named2.started === "number" && named1.title !== "Buffer overflow in vuln.c",
  "name_session dà il titolo della chat alla sua sessione",
);

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
await fs.mkdir(path.join(project, "trasloco", "vuota"), { recursive: true });
await fs.mkdir(path.join(project, "destinazione"));
const moveReply = nextMessage((m) => m.reqId === "trasloco");
const moveEvent = nextMessage((m) => m.type === "directory_moved", other);
game.send(JSON.stringify({ type: "request", reqId: "trasloco", op: "move_dir", path: "trasloco", to: "destinazione" }));
await Promise.all([moveReply, moveEvent]);
check(received.find((m) => m.reqId === "trasloco")?.data?.to === "destinazione/trasloco" &&
  otherGot.some((m) => m.type === "directory_moved" && m.from === "trasloco" && m.to === "destinazione/trasloco") &&
  (await fs.stat(path.join(project, "destinazione", "trasloco", "vuota"))).isDirectory(),
"il ponte conferma lo spostamento di una cartella e avvisa le altre finestre");
other.close();
r = await client.callTool({ name: "get_game_state", arguments: {} });
check(/Chi legge ha chiesto: frasi brevi/.test(text(r)) && /"piu_schemi"/.test(text(r)), "get_game_state riporta le preferenze di chi legge");
check(/Lingua scelta nel gioco: italiano/.test(text(r)) && /"lang": "it"/.test(text(r)), "get_game_state riporta la lingua scelta");
const ws2 = new WebSocket(`ws://127.0.0.1:${PORT2}/ws`);
const hello2 = await new Promise<any>((res) => ws2.once("message", (d) => res(JSON.parse(String(d)))));
const nextTutor = client2.callTool({ name: "wait_for_question", arguments: { timeout_seconds: 10 } });
await new Promise((res) => setTimeout(res, 150));
const longLog = "a".repeat(8191) + "🪲\r\nUltima riga\n";
const img26 = await askWithImages(ws2, { op: "ask_with_text", attachment: longLog, text: "Qui?", images: [png], context: {
  mode: "tutor", level: "medio", file: "protocol.py", lines: [2501, 2501], selection: "def solve():",
  changed: [[1, 1]], buffer: { file: "protocol.py", content: draft, dirty: true },
} });
const nextTutorResult = await nextTutor;
const answerText = nextTutorResult.content[0].type === "text" ? nextTutorResult.content[0].text : "";
const [question] = JSON.parse(answerText.slice(answerText.indexOf("\n")));
check(question.context.buffer.startLine === 2498 && question.context.buffer.content.includes("def solve():"), "wait_for_question privilegia la selezione in MCP 2026");
check(img26.ok && img26.data === question.id && question.imageCount === 1 &&
  nextTutorResult.content.some((item) => item.type === "image" && item.data === png.data && item.mimeType === png.mimeType),
  "wait_for_question in MCP 2026 restituisce anche i byte dell'immagine");
r = await client2.callTool({ name: "read_question_image", arguments: { question_id: question.id, index: 1 } });
check(r.content[0]?.type === "image" && r.content[0].data === png.data, "read_question_image è disponibile anche in MCP 2026");
check(question.textBytes === Buffer.byteLength(longLog) && !answerText.includes("Ultima riga"), "la coda segnala il log senza duplicarlo");
const readPage = async (offset: number) => {
  const page = await client2.callTool({ name: "read_question_text", arguments: { question_id: question.id, offset } });
  const body = text(page);
  return JSON.parse(body.slice(body.indexOf("\n")));
};
const firstPage = await readPage(0);
const lastPage = await readPage(firstPage.nextOffset);
check(firstPage.text + lastPage.text === longLog && lastPage.nextOffset === question.textBytes, "MCP 2026 rilegge il log completo anche se una pagina termina dentro un carattere UTF-8");
r = await client2.callTool({ name: "read_tutor_buffer", arguments: { question_id: question.id, start: 1, end: 1 } });
check(text(r).endsWith("# esempio"), "MCP 2026 recupera le righe del buffer");
r = await client2.callTool({ name: "show_dialog", arguments: { text: "Guarda qui.", question_id: question.id, highlight: { path: "protocol.py", start: 2501, end: 2501 } } });
check(!r.isError, "MCP 2026 evidenzia una riga presente solo nel buffer modificato");
ws2.close();
check(hello2.prefs?.settings?.level === "facile" && hello2.prefs.reader?.aids.includes("piu_schemi"), "le preferenze valgono anche per un altro server (stesso database)");
await client2.close();

// un agente in modalità auto chiede server/discover e sceglie da solo il protocollo più recente
const third = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/server/cli.ts", "mcp", "--project", project, "--port", String(PORT)],
  stderr: "pipe",
  env,
});
const client3 = new Client({ name: "test-agente-3", version: "0.0.1" }, { versionNegotiation: { mode: "auto" } });
await client3.connect(third);
check(client3.getProtocolEra() === "modern", "in modalità auto si sceglie il protocollo 2026-07-28");
r = await client3.callTool({ name: "list_tours", arguments: {} });
check(!r.isError && text(r).length > 0, "uno strumento risponde anche col protocollo 2026-07-28");
await client3.close();

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

const invalidImage = await askWithImages(game, { text: "Immagine non valida", images: [{ ...png, mimeType: "image/jpeg" }], context: { level: "medio" } });
check(invalidImage.ok === false && /formato/.test(invalidImage.error), "il ponte rifiuta immagini con formato dichiarato diverso dai byte");
const img25 = await askWithImages(game, { text: "", images: [png, largerPng], context: { level: "medio", lang: "it" } });
await new Promise((res) => setTimeout(res, 150));
const imageEvent = pushed.at(-1);
check(img25.ok && imageEvent?.meta.question_id === img25.data && imageEvent.meta.image_count === "2" &&
  /read_question_image/.test(imageEvent.content) && !imageEvent.content.includes(png.data),
  "il canale 2025 indica come recuperare gli allegati di una domanda senza testo");
r = await client.callTool({ name: "get_user_questions", arguments: {} });
const queuedImages = r.content.filter((item) => item.type === "image");
check(queuedImages.length === 2 && queuedImages[0].data === png.data && queuedImages[1].data === largerPng.data &&
  /"imageCount": 2/.test(text(r)) && !/Immagine non valida/.test(text(r)), "get_user_questions in MCP 2025 consegna solo le immagini accettate, nell'ordine di invio");
r = await client.callTool({ name: "read_question_image", arguments: { question_id: img25.data, index: 2 } });
check(r.content[0]?.type === "image" && r.content[0].data === largerPng.data, "l'immagine si rilegge anche dopo aver svuotato la coda");
r = await client.callTool({ name: "read_question_image", arguments: { question_id: "../../package", index: 1 } });
check(r.isError, "read_question_image rifiuta percorsi esterni");
const savedImages = await new Project(project).loadQuestionImages(img25.data);
const savedQuestion = await new Project(project).loadConversation(img25.data);
check(savedImages[1]?.data === largerPng.data && savedQuestion.turns[0].question.imageCount === 2 &&
  !JSON.stringify(savedQuestion).includes(png.data), "gli allegati persistono separati dal JSON della conversazione");

const logOnly = await askWithImages(game, { op: "ask_with_text", attachment: longLog, text: "", context: { level: "medio" } });
await new Promise((resolve) => setTimeout(resolve, 150));
const logEvent = pushed.at(-1);
check(logOnly.ok && logEvent?.meta.text_bytes === String(Buffer.byteLength(longLog)) &&
  logEvent.content.includes("read_question_text") && !logEvent.content.includes("Ultima riga"), "il canale indica come leggere un log senza didascalia");
r = await client.callTool({ name: "read_question_text", arguments: { question_id: logOnly.data, offset: 8191 } });
check(!r.isError && text(r).includes("Ultima riga"), "il canale MCP 2025 può leggere direttamente la fine del log");
r = await client.callTool({ name: "read_question_text", arguments: { question_id: "../../package" } });
check(r.isError, "il lettore dei log verifica l’id della domanda");
const logTurn = (await new Project(project).loadConversation(logOnly.data)).turns[0];
check(logTurn.question.textBytes === Buffer.byteLength(longLog) && !JSON.stringify(logTurn).includes("Ultima riga"), "la cronologia conserva il riferimento al testo completo");
const tooLarge = await askWithImages(game, { op: "ask_with_text", attachment: "x".repeat(5 * 1024 * 1024 + 1), context: { level: "medio" } });
check(!tooLarge.ok && /5 MiB/.test(tooLarge.error), "il ponte rifiuta esplicitamente un log oltre il limite");
game.close();
evil.close();
await client.close();
await fs.rm(dataDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} controlli falliti` : "\nTutti i controlli passati.");
process.exit(failures ? 1 : 0);
