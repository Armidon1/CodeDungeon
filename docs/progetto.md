# Code Dungeon · specifica e roadmap

Sintesi del brainstorming del 23 ottobre 2026. È il riferimento per le tappe successive.

## Concetto

Un gioco cozy in pixel art che usa un LLM per spiegare il codice generato da un LLM. L'interfaccia ricrea VS Code; una guida con ritratto e fumetti (stile dialoghi di un dungeon crawler, solo come estetica) spiega il codice seguendo il flusso reale di esecuzione. Esempio: in un backend che gestisce connessioni in entrata, si parte dal pacchetto, si legge l'header e si arriva con un'animazione all'handler giusto.

Pubblico: dal non programmatore che ha generato uno script e non sa cosa fa, fino all'esperto di cybersecurity che vuole l'analisi a basso livello.

## Architettura

- **Dipendenza invertita:** il gioco è un server MCP; qualsiasi agente compatibile (Claude Code, Codex, Gemini CLI, futuri) lo pilota. Nessun adattatore per tool.
- **Copione + dal vivo:** l'agente costruisce un tour JSON con gli strumenti MCP; il gioco lo riproduce senza latenza. Le domande dal vivo passano dall'agente in tempo reale.
- **Istruzioni per l'agente:** nel prompt MCP `crea_tour` e in `docs/come-fare-un-tour.md`.
- **Da evitare:** leggere l'output grafico dei terminali degli agenti (cambia a ogni aggiornamento).
- **Facoltativo, più avanti:** un adattatore per avviare l'agente dal gioco usando le modalità headless (output JSON di Claude Code, Agent SDK, `codex exec`).

## Funzionalità

### Livelli e generazione
- Quattro livelli: facile, medio, difficile, arduo. Si sceglie nel menu iniziale e si cambia durante il tour.
- Modalità **istantanea**: tutti i livelli generati subito (fluida, più token).
- Modalità **su richiesta**: solo il livello attivo; al cambio l'agente riscrive passo corrente e successivi usando come contesto il livello di partenza e le domande già fatte. Il passo successivo si prepara in background. Durante l'attesa la guida è pensierosa: "fammi pensare...".

### Personalizzazione della guida
- Ritratto neutro predefinito; ritratti predefiniti alternativi (femminile, maschile, neutro).
- Bordo della finestra di dialogo e contorni del ritratto sempre in pixel art.
- Upload di un'immagine (anche una foto): conversione in pixel art con **tre livelli di compressione** mostrati affiancati in anteprima, più uno slider.
- Espressioni per ogni ritratto (felice, pensieroso, preoccupato, sorpreso…): generate automaticamente per le immagini caricate, oppure caricate dall'utente.

### Lavagna degli schemi
- Finestra-lavagna in pixel art dentro il gioco: diagrammi di flusso, architetture, sequenze di chiamate.
- Schema completo subito, oppure tracciato linea per linea mentre l'agente spiega.
- L'agente scrive lo schema in JSON (`.tour/schemi/<id>.json`: nodi, archi, tipo `flusso` o `sequenza`) e il gioco lo disegna in stile pixel.
- Durante la spiegazione lo schema compare in una finestra a comparsa; resta salvato e si riapre come scheda dell'editor o dall'elenco "Schemi".
- I nodi con codice collegato (gemma) aprono il file alle righe giuste.

### Accessibilità (DSA e altre esigenze)
- Questionario su cosa aiuta: più schemi, frasi brevi, font ad alta leggibilità, meno testo per volta.
- Le risposte entrano nel contesto dell'agente.
- **Nessun caricamento di certificati**: sono dati sanitari (categoria particolare GDPR). Le risposte restano solo in locale.

## Stack

| Componente | Scelta |
| --- | --- |
| Linguaggio | TypeScript |
| App desktop | Tauri (tappa futura; oggi gira nel browser) |
| Grafica | DOM + canvas per sprite ed effetti; PixiJS o Phaser se servirà un motore |
| Server MCP | SDK ufficiale MCP per TypeScript |
| Tour | JSON in `.tour/` nel progetto spiegato, versionati su Git |
| Impostazioni | SQLite (oggi localStorage) |

## Roadmap

1. **Versione minima** ✅ editor pixelato, fumetto con ritratto, server MCP con `open_file`, `highlight_lines`, `show_dialog`.
2. **Tour** ✅ formato JSON, `.tour/`, riproduzione con animazioni, `create_tour`, `add_step`, diramazioni.
3. **Domande dal vivo** ✅ base: domanda nel gioco → `get_user_questions` → `show_dialog`. Notifica all'agente: canale di Claude Code (domande spinte nella sessione) e `wait_for_question` per gli altri agenti; coda dei fumetti. Da fare: cronologia della conversazione nel gioco.
4. **Difficoltà** ✅ base: menu, cambio durante il tour, `set_step_text` per la modalità su richiesta. Da fare: preparazione in background del passo successivo.
5. **Lavagna** ✅ schemi JSON in `.tour/schemi/`, `draw_diagram`, `reveal_diagram`, `set_step_diagram`, rendering pixel con disegno progressivo, finestra a comparsa, scheda nell'editor, nodi che aprono il codice.
6. **Personalizzazione** ✅ ritratti predefiniti (Lumen, Aria, Patrizio, Nilo), nome della guida, upload convertito in pixel art nel browser (ritaglio, riduzione, k-means) con tre livelli di compressione affiancati e slider, espressioni automatiche (fumetto e colori) o caricate una per una. Il nome arriva all'agente nel contesto (`guide`). Da fare: bordi del fumetto alternativi.
7. **Accessibilità**: questionario, salvataggio in SQLite tramite il ponte, adattamento delle spiegazioni.
8. **Distribuzione**: app Tauri, pacchetto npm (`npx code-dungeon mcp`), test con almeno due agenti diversi.

## Questioni aperte

- Elenco definitivo degli strumenti MCP e dei loro parametri per le tappe 6-7.
- Sprite e palette: disegnati a mano (oggi generati da codice) o con licenza libera.
- Fonti esterne per le risposte: strumenti di ricerca del client o strumenti del gioco.
