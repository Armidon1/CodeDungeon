# Istruzioni per gli agenti che sviluppano Code Dungeon

Questo file è per chi lavora **sul codice di Code Dungeon**. Le istruzioni per costruire un tour in un altro progetto sono in `docs/come-fare-un-tour.md` (esposte anche come prompt MCP `crea_tour`).

## Contesto

Leggi `docs/progetto.md`: specifica completa e roadmap a tappe. Lavora una tappa alla volta e aggiorna la roadmap quando ne chiudi una.

## Struttura

- `src/shared/types.ts`: tipi del tour e protocollo WebSocket, condivisi da server e gioco. Si parte sempre da qui quando cambia un formato.
- `src/server/`: `cli.ts` (modi `mcp` e `play`), `mcp.ts` (strumenti e prompt), `bridge.ts` (HTTP + WebSocket su 127.0.0.1), `project.ts` (accesso ai file confinato nella radice; tour, schemi e conversazioni in `.tour/`), `store.ts` (impostazioni e questionario in SQLite nella cartella dati dell'utente).
- `src/game/`: gioco nel browser senza framework. `app.ts` (UI e riproduzione dei tour), `i18n.ts` (testi dell'interfaccia in inglese e italiano), `portrait.ts` (ritratti 32×32 delle guide e immagine dell'utente), `guide.ts` (scelta della guida nel menu), `chat.ts` (modalità chat: storico dei fumetti con schede di codice), `reader.ts` (aiuti alla lettura: classi CSS, movimento ridotto, fumetto a pagine), `settings.ts` (impostazioni e sincronizzazione col ponte), `pixelate.ts` (immagine → pixel art), `diagram.ts` (lavagna degli schemi), `audio.ts` (musiche, effetti e voce della guida), `highlight.ts` (sintassi), `source.ts` e `demo-source.ts` (ponte o demo incorporata), `sessions.ts` (sessioni aperte su 7337-7356 via `GET /session`, scelta e cambio), `layout.ts` (divisori, anche quelli della modalità chat con misure proprie, finestra della lavagna e finestra classica ridimensionabili, pannello laterale scelto, tutto in localStorage), `fullscreen.ts` (schermo intero: Fullscreen API nel browser, finestra Tauri nell'app).
- `src-tauri/`: app desktop Tauri 2. Solo una finestra su `dist/game`, senza comandi nativi (unici permessi: schermo intero della finestra); il gioco cerca le sessioni aperte con `resolveBridge()` di `sessions.ts`. Il server resta in Node.
- `examples/packet-server/`: progetto d'esempio con tour in `.tour/` e schemi in `.tour/schemi/`. Tieni allineati i numeri di riga del tour se modifichi i file Python.

## Comandi

- `npm run typecheck` e `npm run test:mcp` prima di considerare finito un cambiamento.
- `npm run dev` + `npm run play -- --project examples/packet-server` per lavorare sul gioco.
- `npm run app:build` compila l'app desktop (serve Rust); `npm run app:dev` la apre su `npm run dev`.
- `npm run build:demo` produce `dist/demo/index.html`, un file unico senza ponte.

## Regole

- In modalità MCP lo stdout è del protocollo: log solo con `log()` (stderr).
- Ogni accesso a file del progetto passa da `Project.resolveInside()`. Non aggiungere letture o scritture fuori da lì. L'unica eccezione è il database di `store.ts`, a percorso fisso.
- Il ponte resta su 127.0.0.1 con controllo dell'origine dei WebSocket.
- Testi dell'interfaccia in `src/game/i18n.ts`, in inglese e in italiano (stesse chiavi, niente testo letterale nei componenti: `t()` in TS, `data-i18n` in HTML). Messaggi degli strumenti MCP in italiano. Sempre frasi brevi e concrete.
- Rispetta il movimento ridotto per ogni nuova animazione (`reducedMotion()` di `reader.ts` in TS, regole `prefers-reduced-motion` e `.meno-movimento` in CSS) e verifica il layout a 390 px di larghezza.
- Audio: tutto sintetizzato con Web Audio in `audio.ts`, niente file audio né musiche altrui. Ogni nuovo suono passa dai bus musica/effetti, così volumi e tasto M valgono anche per lui.
- Grafica: pixel nitidi (`image-rendering: pixelated`), palette nei token CSS di `styles.css`, niente colori letterali nei componenti.
