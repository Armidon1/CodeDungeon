#!/usr/bin/env node
// Punto d'ingresso.
//   code-dungeon mcp  [--project <cartella>] [--port 7337]   server MCP (stdio) + ponte verso il gioco
//   code-dungeon play [--project <cartella>] [--port 7337]   solo il ponte: riproduci i tour salvati senza agente
// Se la porta è occupata (un'altra sessione) si usa la prima libera dopo di lei: l'indirizzo è nel log e negli strumenti.

import { existsSync } from "node:fs";
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

function findStaticDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../game"), path.resolve(here, "../../dist/game")];
  return candidates.find((d) => existsSync(path.join(d, "index.html")));
}

async function main(): Promise<void> {
  const { mode, opts } = parseArgs(process.argv.slice(2));
  if (mode !== "mcp" && mode !== "play") {
    process.stderr.write("Uso: code-dungeon <mcp|play> [--project <cartella>] [--port 7337]\n");
    process.exit(2);
  }
  const projectDir = opts.project || process.env.CODE_DUNGEON_PROJECT || process.cwd();
  const port = Number(opts.port || process.env.CODE_DUNGEON_PORT || 7337);
  if (!existsSync(projectDir)) {
    log(`cartella del progetto non trovata: ${projectDir}`);
    process.exit(1);
  }
  const project = new Project(projectDir);
  const bridge = new Bridge({ project, port, staticDir: findStaticDir(), agent: mode === "mcp" });

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
