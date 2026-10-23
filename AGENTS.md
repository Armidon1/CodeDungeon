# Istruzioni per gli agenti che sviluppano Code Dungeon

Questo file è per chi lavora **sul codice di Code Dungeon**. Le istruzioni per costruire un tour in un altro progetto sono in `docs/come-fare-un-tour.md` (esposte anche come prompt MCP `crea_tour`).

## Contesto

Leggi `docs/progetto.md`: specifica completa e roadmap a tappe. Lavora una tappa alla volta e aggiorna la roadmap quando ne chiudi una.

## Struttura

- `src/shared/types.ts`: tipi del tour e protocollo WebSocket, condivisi da server e gioco. Si parte sempre da qui quando cambia un formato.
- `src/server/`: `cli.ts` (modi `mcp` e `play`), `mcp.ts` (strumenti e prompt), `bridge.ts` (HTTP + WebSocket su 127.0.0.1), `project.ts` (accesso ai file confinato nella radice e tour in `.tour/`), `store.ts` (impostazioni e questionario in SQLite nella cartella dati dell'utente).
- `src/game/`: gioco nel browser senza framework. `app.ts` (UI e riproduzione dei tour), `portrait.ts` (ritratti 32×32 delle guide e immagine dell'utente), `guide.ts` (scelta della guida nel menu), `reader.ts` (aiuti alla lettura: classi CSS, movimento ridotto, fumetto a pagine), `settings.ts` (impostazioni e sincronizzazione col ponte), `pixelate.ts` (immagine → pixel art), `diagram.ts` (lavagna degli schemi), `highlight.ts` (sintassi), `source.ts` e `demo-source.ts` (ponte o demo incorporata).
- `examples/packet-server/`: progetto d'esempio con tour in `.tour/` e schemi in `.tour/schemi/`. Tieni allineati i numeri di riga del tour se modifichi i file Python.

## Comandi

- `npm run typecheck` e `npm run test:mcp` prima di considerare finito un cambiamento.
- `npm run dev` + `npm run play -- --project examples/packet-server` per lavorare sul gioco.
- `npm run build:demo` produce `dist/demo/index.html`, un file unico senza ponte.

## Regole

- In modalità MCP lo stdout è del protocollo: log solo con `log()` (stderr).
- Ogni accesso a file del progetto passa da `Project.resolveInside()`. Non aggiungere letture o scritture fuori da lì. L'unica eccezione è il database di `store.ts`, a percorso fisso.
- Il ponte resta su 127.0.0.1 con controllo dell'origine dei WebSocket.
- Testi dell'interfaccia e messaggi degli strumenti in italiano, frasi brevi e concrete.
- Rispetta il movimento ridotto per ogni nuova animazione (`reducedMotion()` di `reader.ts` in TS, regole `prefers-reduced-motion` e `.meno-movimento` in CSS) e verifica il layout a 390 px di larghezza.
- Grafica: pixel nitidi (`image-rendering: pixelated`), palette nei token CSS di `styles.css`, niente colori letterali nei componenti.
