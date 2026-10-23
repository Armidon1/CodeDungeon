# Code Dungeon

Un gioco cozy in pixel art che spiega il codice generato dagli LLM. Una guida (Lumen, una piccola lanterna, o quella che scegli tu) ti accompagna dentro una versione pixelata di VS Code e segue il **flusso reale del programma**: dal pacchetto che arriva fino alla funzione che risponde.

Il gioco è un **server MCP**: non contiene un agente proprio, lo pilota quello che usi già (Claude Code, Codex, Gemini CLI o qualsiasi client MCP). L'agente costruisce il tour con gli strumenti del gioco e risponde dal vivo alle tue domande.

```
agente (Claude Code / Codex / Gemini CLI) ──MCP stdio──▶ server Code Dungeon ──WebSocket──▶ gioco nel browser
                                                          │
                                                          └─ .tour/*.json nel tuo progetto (finiscono su Git)
```

## Stato: tappa 7 di 8

Funziona già:

- editor VS Code pixelato con evidenziazione della sintassi (Python, JS/TS) e delle righe;
- la guida con 5 espressioni animate e la mini-guida che cammina tra i file, con dissolvenza a pixel nel cambio file;
- guida a scelta nel menu: Lumen, Aria, Patrizio, Nilo, oppure una tua foto o un disegno convertito in pixel art (tre livelli di compressione affiancati e uno slider), con le espressioni automatiche o caricate una per una; il nome lo scegli tu. L'immagine resta nel browser;
- tour JSON con diramazioni (scelte nel dialogo), avanti e indietro;
- menu iniziale con 4 livelli (facile, medio, difficile, arduo) e modalità di generazione, livello cambiabile durante il tour;
- domande dal vivo: le scrivi nel gioco, l'agente le legge e risponde nel fumetto;
- questionario "Cosa ti aiuta a capire" nel menu: frasi brevi, poco testo per volta (fumetto a pagine), più schemi, esempi, termini spiegati, font ad alta leggibilità (Atkinson Hyperlegible), testo più grande, meno animazioni. Il gioco si adatta subito, l'agente riceve le richieste e adatta le spiegazioni;
- impostazioni salvate in SQLite sul tuo computer, uguali in tutti i progetti;
- lavagna degli schemi: l'agente disegna flussi e sequenze in pixel art, pezzo per pezzo mentre spiega; lo schema compare in una finestra e resta come scheda dell'editor (e nell'elenco "Schemi");
- layout per telefono;
- progetto d'esempio `examples/packet-server` (server TCP in Python) con un tour di 11 passi, inclusa una vera falla DoS.

La roadmap completa è in [docs/progetto.md](docs/progetto.md).

## Installazione da zero

Questa guida parte da un computer senza niente. Il server MCP si installa una volta sola e poi vale in tutti i tuoi progetti. Servono una decina di minuti.

### 1. Cosa ti serve

- **Node.js 22.13 o superiore** (serve il modulo SQLite integrato). Controlla con `node --version`. Se manca o è vecchio, installalo da [nodejs.org](https://nodejs.org) (versione LTS) oppure con il gestore di pacchetti del sistema (`brew install node`, `sudo dnf install nodejs`, `sudo apt install nodejs npm`, `winget install OpenJS.NodeJS.LTS`).
- **Git**, per scaricare il repository (`git --version`).
- **Un agente da terminale** già installato e funzionante: [Claude Code](https://docs.claude.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex) o [Gemini CLI](https://github.com/google-gemini/gemini-cli). Va bene anche qualsiasi altro client MCP.
- **Un browser**, dove si gioca.

### 2. Scarica e compila Code Dungeon

Scegli una cartella dove tenerlo, ad esempio la home, e lascialo lì: l'agente lo avvia da quel percorso.

```bash
cd ~
git clone https://github.com/Armidon1/CodeDungeon.git code-dungeon
cd code-dungeon
npm install
npm run build
```

`npm run build` crea `dist/server` (il server MCP) e `dist/game` (il gioco). Se finisce senza errori, è pronto.

### 3. Annota il percorso del server

Il comando da dare all'agente è `node <percorso>/dist/server/cli.js mcp`. Stampa il percorso completo con:

```bash
echo "$(pwd)/dist/server/cli.js"      # macOS e Linux
```

Su Windows (PowerShell) usa `"$PWD\dist\server\cli.js"`. Negli esempi qui sotto sostituisci `/percorso/code-dungeon` con la tua cartella: deve essere un **percorso assoluto**, non `~/…` né relativo.

Prova che il server parta da solo (facoltativo):

```bash
npm run play -- --project examples/packet-server
```

Apri http://127.0.0.1:7337: vedi il menu del gioco e puoi riprodurre il tour d'esempio. Chiudi con Ctrl+C.

### 4. Registra il server nel tuo agente

Fallo per l'agente che usi. Il server lavora sulla cartella in cui avvii l'agente: non devi indicare nessun progetto.

**Claude Code**

```bash
claude mcp add --scope user code-dungeon -- node /percorso/code-dungeon/dist/server/cli.js mcp
```

`--scope user` lo rende disponibile in tutte le cartelle. Controlla con `claude mcp list`: deve comparire `code-dungeon` con `✓ Connected`. Dentro una sessione, il comando `/mcp` mostra lo stesso stato.

**Codex CLI**

Aggiungi a `~/.codex/config.toml` (crealo se non esiste):

```toml
[mcp_servers.code-dungeon]
command = "node"
args = ["/percorso/code-dungeon/dist/server/cli.js", "mcp"]
tool_timeout_sec = 1800   # wait_for_question resta in ascolto più dei 60 secondi predefiniti
```

In alternativa `codex mcp add code-dungeon -- node /percorso/code-dungeon/dist/server/cli.js mcp`, poi aggiungi a mano la riga `tool_timeout_sec`. Controlla con `codex mcp list`, oppure con `/mcp` dentro Codex.

**Gemini CLI**

Aggiungi a `~/.gemini/settings.json` (per tutti i progetti) oppure a `.gemini/settings.json` dentro un progetto:

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

Se il file ha già altre impostazioni, aggiungi solo la voce `code-dungeon` dentro `mcpServers`. Controlla con `/mcp` dentro Gemini CLI.

**Altri client MCP**

Il server parla MCP su stdio. Comando `node`, argomenti `["/percorso/code-dungeon/dist/server/cli.js", "mcp"]`. Per un progetto diverso dalla cartella di lavoro aggiungi `"--project", "/percorso/del/progetto"`.

### 5. Il primo tour

1. Nel terminale entra nel progetto che vuoi farti spiegare e avvia l'agente (`claude`, `codex` o `gemini`).
2. Chiedi: *"Crea un tour Code Dungeon di come questo programma gestisce una richiesta"*. In Claude Code c'è anche il comando `/mcp__code-dungeon__crea_tour`.
3. L'agente legge il codice, scrive il tour e ti dà l'indirizzo del gioco: di solito http://127.0.0.1:7337. Se la porta è occupata usa la prima libera dopo, quindi apri quello che ti dice lui.
4. Nel gioco scegli il livello e segui la guida. Le domande le scrivi direttamente nel gioco: la risposta arriva nel fumetto.

I tour e gli schemi vengono salvati in `.tour/` nel tuo progetto. Puoi metterli su Git e chi clona il progetto li ritrova.

### Se qualcosa non va

- **L'agente non vede gli strumenti di Code Dungeon.** Riavvia l'agente dopo averlo registrato e controlla con `/mcp` o `mcp list`. Se risulta non connesso, di solito il percorso di `cli.js` è sbagliato o non hai lanciato `npm run build`.
- **`node: command not found` oppure un errore di sintassi all'avvio.** Node manca o è più vecchio della versione 22.13.
- **Il gioco non si apre.** Il server si avvia insieme all'agente, quindi l'agente deve essere aperto. Chiedigli l'indirizzo esatto (strumento `get_game_state`).
- **Scrivi una domanda nel gioco e non succede niente.** Vedi [Domande senza tornare al terminale](#domande-senza-tornare-al-terminale). Se l'agente ha chiuso il turno, scrivigli nel terminale *"rispondi alle domande nel gioco"*.

### Aggiornare

```bash
cd /percorso/code-dungeon
git pull
npm install
npm run build
```

Poi riavvia l'agente. Non serve registrare di nuovo il server.

## Provalo subito, senza agente

```bash
npm run play -- --project examples/packet-server
```

Apri http://127.0.0.1:7337 e scegli il livello. In questa modalità puoi riprodurre i tour salvati ma non fare domande.

## Domande senza tornare al terminale

Dopo aver avviato un tour o risposto a una domanda, l'agente resta in ascolto da solo (`wait_for_question`): scrivi nel gioco e la risposta arriva nel fumetto, con qualsiasi agente. Per parlargli di altro nel terminale, interrompilo (in Claude Code con Esc). Alcuni agenti (es. Codex) a volte chiudono il turno invece di aspettare: la domanda non si perde, il gioco dopo 30 secondi ti ricorda di scrivere all'agente *"rispondi alle domande nel gioco"*.

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
| `show_dialog` | fa parlare la guida, con un'espressione |
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
- Nel progetto scrive solo in `.tour/`, con id validati e scrittura atomica.
- Fuori dal progetto scrive un solo file: `code-dungeon.db` (SQLite) con le impostazioni e le risposte al questionario, nella cartella dati dell'utente (`~/.local/share/code-dungeon` su Linux, `~/Library/Application Support/code-dungeon` su macOS, `%APPDATA%\code-dungeon` su Windows; si cambia con `CODE_DUNGEON_DATA`). Non finisce su Git e non esce dal computer, tranne quello che l'agente legge per adattare le spiegazioni. Il gioco non chiede certificati né diagnosi.
- File oltre 512 KB o binari non vengono aperti.
- Le domande spinte nella sessione di Claude Code arrivano solo dal gioco aperto in locale (stesso controllo dell'origine).
