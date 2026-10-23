#!/usr/bin/env node
// Punto d'ingresso.
//   code-dungeon mcp  [--project <cartella>] [--port 7337]   server MCP (stdio) + ponte verso il gioco
//   code-dungeon play [--project <cartella>] [--port 7337]   solo il ponte: riproduci i tour salvati senza agente
// Se la porta è occupata (un'altra sessione) si usa la prima libera dopo di lei: l'indirizzo è nel log e negli strumenti.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge.js";
import { createMcpServer } from "./mcp.js";
import { Project } from "./project.js";
import { log } from "./log.js";

function parseArgs(argv: string[]) {
  const [mode = "mcp", ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) opts[a.slice(2)] = rest[i + 1] ?? "";
    if (a.startsWith("--")) i++;
  }
  return { mode, opts };
}

const USAGE = `Code Dungeon: un gioco in pixel art che spiega il codice, pilotato dal tuo agente via MCP.

Uso:
  code-dungeon mcp  [--project <cartella>] [--port 7337]   server MCP (stdio) + gioco nel browser
  code-dungeon play [--project <cartella>] [--port 7337]   riproduci i tour salvati, senza agente
  code-dungeon --version

Il progetto predefinito è la cartella corrente. Guida: https://github.com/Armidon1/CodeDungeon#readme
`;

function version(): string {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
}

function findStaticDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../game"), path.resolve(here, "../../dist/game")];
  return candidates.find((d) => existsSync(path.join(d, "index.html")));
}

async function main(): Promise<void> {
  const { mode, opts } = parseArgs(process.argv.slice(2));
  if (mode === "--version" || mode === "-v") {
    process.stdout.write(`${version()}\n`);
    return;
  }
  if (mode !== "mcp" && mode !== "play") {
    const help = mode === "--help" || mode === "-h" || mode === "help";
    (help ? process.stdout : process.stderr).write(USAGE);
    process.exit(help ? 0 : 2);
  }
  const projectDir = opts.project || process.env.CODE_DUNGEON_PROJECT || process.cwd();
  const port = Number(opts.port || process.env.CODE_DUNGEON_PORT || 7337);
  if (!existsSync(projectDir)) {
    log(`cartella del progetto non trovata: ${projectDir}`);
    process.exit(1);
  }
  // node:sqlite è ancora "sperimentale" in Node 22-24: il suo avviso a ogni avvio confonde chi legge il log
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (!(w.name === "ExperimentalWarning" && /SQLite/.test(w.message))) log(`${w.name}: ${w.message}`);
  });
  const { Store } = await import("./store.js");
  const project = new Project(projectDir);
  const bridge = new Bridge({ project, port, staticDir: findStaticDir(), agent: mode === "mcp", store: new Store() });

  try {
    await bridge.start();
    log(`gioco su ${bridge.url} · progetto: ${project.root}`);
  } catch (e) {
    const busy = (e as NodeJS.ErrnoException).code === "EADDRINUSE";
    log(busy ? `porte ${port}-${port + 19} occupate: il ponte verso il gioco è disattivato` : `ponte non avviato: ${String(e)}`);
    if (mode === "play") process.exit(1);
  }

  if (mode === "mcp") {
    const server = createMcpServer(project, bridge);
    await server.connect(new StdioServerTransport());
    log("server MCP pronto su stdio");
  }
}

main().catch((e) => {
  log(`errore fatale: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
