// Titolo della chat dell'agente che ha avviato questo server ("Cartelle e terminale nel TODO").
// Claude Code non lo passa via MCP, ma lo scrive su disco:
//   <config>/sessions/<pid>.json        pid del processo claude → sessionId e cwd
//   <config>/projects/<cwd>/<id>.jsonl  trascrizione, con righe {"type":"ai-title","aiTitle":...}
// Solo lettura, a percorsi fissi nella cartella di Claude Code: come il database di store.ts,
// non passa da Project.resolveInside(). Con altri agenti, o se i file mancano, dà undefined.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Quanto leggere dalla fine della trascrizione: il titolo viene riscritto spesso, quindi è vicino alla fine. */
const TAIL_BYTES = 512 * 1024;
const TITLE_RE = /"type":"(?:custom-title|ai-title)","(?:customTitle|aiTitle)":("(?:[^"\\]|\\.)*")/g;

const configDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

/** pid dei processi antenati (padre, nonno...), per chi avvia il server tramite npx o una shell. */
function ancestors(): number[] {
  const out = [process.ppid];
  for (let i = 0; i < 4; i++) {
    try {
      const stat = readFileSync(`/proc/${out[out.length - 1]}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!ppid || ppid <= 1) break;
      out.push(ppid);
    } catch {
      break; // niente /proc (macOS, Windows): basta il padre
    }
  }
  return out;
}

interface Found {
  file: string;
}

let found: Found | null | undefined;
let cache: { mtime: number; size: number; title: string | undefined } | undefined;

function findTranscript(): Found | null {
  const dir = configDir();
  for (const pid of ancestors()) {
    const meta = path.join(dir, "sessions", `${pid}.json`);
    if (!existsSync(meta)) continue;
    try {
      const { sessionId, cwd } = JSON.parse(readFileSync(meta, "utf8")) as { sessionId?: string; cwd?: string };
      if (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId)) continue;
      const name = `${sessionId}.jsonl`;
      if (typeof cwd === "string") {
        const guess = path.join(dir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), name);
        if (existsSync(guess)) return { file: guess };
      }
      for (const p of readdirSync(path.join(dir, "projects"))) {
        const f = path.join(dir, "projects", p, name);
        if (existsSync(f)) return { file: f };
      }
    } catch {
      /* file a metà o di un formato diverso: si prova il prossimo */
    }
  }
  return null;
}

function lastTitle(file: string, size: number): string | undefined {
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  let title: string | undefined;
  for (const m of buf.toString("utf8").matchAll(TITLE_RE)) {
    try {
      const t = JSON.parse(m[1]) as string;
      if (t.trim()) title = t.trim().slice(0, 120);
    } catch {
      /* riga tagliata all'inizio della finestra */
    }
  }
  return title;
}

/** Titolo attuale della chat di Claude Code che ha avviato il server, se si trova. */
export function chatTitle(): string | undefined {
  try {
    // la sessione può comparire qualche istante dopo l'avvio: finché non c'è si riprova
    if (!found) found = findTranscript();
    if (!found) return undefined;
    const st = statSync(found.file);
    if (cache && cache.mtime === st.mtimeMs && cache.size === st.size) return cache.title;
    const title = lastTitle(found.file, st.size) ?? cache?.title;
    cache = { mtime: st.mtimeMs, size: st.size, title };
    return title;
  } catch {
    found = undefined;
    return undefined;
  }
}
