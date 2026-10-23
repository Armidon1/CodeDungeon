# Code Dungeon

Un gioco cozy in pixel art che spiega il codice generato dagli LLM. Lumen, una piccola lanterna, ti guida dentro una versione pixelata di VS Code e segue il **flusso reale del programma**: dal pacchetto che arriva fino alla funzione che risponde.

Il gioco è un **server MCP**: non contiene un agente proprio, lo pilota quello che usi già (Claude Code, Codex, Gemini CLI o qualsiasi client MCP). L'agente costruisce il tour con gli strumenti del gioco e risponde dal vivo alle tue domande.

```
agente (Claude Code / Codex / Gemini CLI) ──MCP stdio──▶ server Code Dungeon ──WebSocket──▶ gioco nel browser
                                                          │
                                                          └─ .tour/*.json nel tuo progetto (finiscono su Git)
```

## Stato: tappa 5 di 8

Funziona già:

- editor VS Code pixelato con evidenziazione della sintassi (Python, JS/TS) e delle righe;
- Lumen con 5 espressioni animate e la mini-guida che cammina tra i file, con dissolvenza a pixel nel cambio file;
- tour JSON con diramazioni (scelte nel dialogo), avanti e indietro;
- menu iniziale con 4 livelli (facile, medio, difficile, arduo) e modalità di generazione, livello cambiabile durante il tour;
- domande dal vivo: le scrivi nel gioco, l'agente le legge e risponde nel fumetto;
- lavagna degli schemi: l'agente disegna flussi e sequenze in pixel art, pezzo per pezzo mentre spiega; lo schema compare in una finestra e resta come scheda dell'editor (e nell'elenco "Schemi");
- layout per telefono;
- progetto d'esempio `examples/packet-server` (server TCP in Python) con un tour di 11 passi, inclusa una vera falla DoS.

La roadmap completa è in [docs/progetto.md](docs/progetto.md).

## Requisiti

Node.js 20 o superiore.

## Installazione

```bash
npm install
npm run build        # compila server (dist/server) e gioco (dist/game)
```

## Provalo subito, senza agente

```bash
npm run play -- --project examples/packet-server
```

Apri http://127.0.0.1:7337 e scegli il livello. In questa modalità puoi riprodurre i tour salvati ma non fare domande.

## Collegalo al tuo agente

Il server parte nella cartella in cui lavora l'agente e la usa come progetto. Per indicarne un'altra aggiungi `--project /percorso/del/progetto`. Sostituisci `/percorso/code-dungeon` con la cartella di questo repository.

**Claude Code**

```bash
claude mcp add --scope user code-dungeon -- node /percorso/code-dungeon/dist/server/cli.js mcp
```

Con `--scope user` vale in tutte le cartelle: non serve spostare nulla, basta avviare `claude` nel progetto da spiegare. I tour e gli schemi finiscono in `.tour/` di quel progetto. Con più sessioni aperte (anche di agenti diversi) ognuna prende la prima porta libera da 7337 in su: l'agente ti dice l'indirizzo del suo gioco.

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.code-dungeon]
command = "node"
args = ["/percorso/code-dungeon/dist/server/cli.js", "mcp"]
```

**Gemini CLI** (`~/.gemini/settings.json` oppure `.gemini/settings.json` nel progetto)

```json
{
  "mcpServers": {
    "code-dungeon": {
      "command": "node",
      "args": ["/percorso/code-dungeon/dist/server/cli.js", "mcp"]
    }
  }
}
```

Poi, dal tuo agente nella cartella del progetto da spiegare:

1. apri il gioco: di solito http://127.0.0.1:7337 (se è occupata, l'agente ti dà l'indirizzo giusto);
2. chiedi: *"Crea un tour Code Dungeon di come questo server gestisce un pacchetto"* (in Claude Code c'è anche il comando `/mcp__code-dungeon__crea_tour`);
3. fai le domande direttamente nel gioco: la risposta arriva nel fumetto di Lumen.

### Domande senza tornare al terminale

Dopo aver avviato un tour o risposto a una domanda, l'agente resta in ascolto da solo (`wait_for_question`): scrivi nel gioco e la risposta arriva nel fumetto, con qualsiasi agente. Per parlargli di altro nel terminale, interrompilo (in Claude Code con Esc). Se l'agente tarda, il gioco ti ricorda come richiamarlo.

**Extra per Claude Code.** Code Dungeon è anche un *canale*: una funzione sperimentale di Claude Code con cui un server può far arrivare un messaggio nella sessione senza essere chiamato. Così le domande arrivano da sole e il terminale resta libero. Gli altri agenti la ignorano. Per attivarla:

```bash
claude --dangerously-load-development-channels server:code-dungeon
```

e conferma l'avviso iniziale (serve perché i canali fatti in casa non sono ancora nell'elenco approvato).

## Strumenti MCP

| Strumento | Cosa fa |
| --- | --- |
| `list_project_files` | elenca i file del progetto |
| `open_file` | apre un file nell'editor, con l'animazione |
| `highlight_lines` | evidenzia un intervallo di righe |
| `show_dialog` | fa parlare Lumen, con un'espressione |
| `get_game_state` | livello, file, righe e passo correnti |
| `get_user_questions` | legge e svuota le domande scritte nel gioco |
| `wait_for_question` | resta in ascolto e restituisce la prossima domanda appena viene scritta |
| `create_tour`, `add_step`, `set_step_text` | costruiscono il copione in `.tour/` |
| `list_tours`, `get_tour`, `play_tour` | elencano, leggono e avviano i tour |
| `draw_diagram` | disegna e salva uno schema in `.tour/schemi/` |
| `reveal_diagram` | mostra uno schema salvato, anche solo i primi pezzi |
| `set_step_diagram` | collega uno schema a un passo del tour |

Prompt: `crea_tour` (guida completa in [docs/come-fare-un-tour.md](docs/come-fare-un-tour.md)).

## Sviluppo

```bash
npm run dev          # gioco con ricarica automatica su http://localhost:5173 (collegato al ponte su :7337)
npm run play -- --project examples/packet-server    # in un altro terminale
npm run typecheck
npm run test:mcp     # prova end-to-end: agente finto + gioco finto
npm run build:demo   # un unico file HTML con l'esempio incorporato, senza ponte
```

## Sicurezza

- Il ponte ascolta solo su `127.0.0.1` e accetta WebSocket solo da pagine locali, per bloccare il cross-site WebSocket hijacking.
- Il server legge solo dentro la cartella del progetto: percorsi assoluti, `../` e link simbolici che escono vengono rifiutati.
- Scrive solo in `.tour/`, con id validati e scrittura atomica.
- File oltre 512 KB o binari non vengono aperti.
- Le domande spinte nella sessione di Claude Code arrivano solo dal gioco aperto in locale (stesso controllo dell'origine).
