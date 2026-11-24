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

### Lingua
- Interfaccia in inglese (predefinita) o italiano, a scelta nel menu.
- L'agente riceve la lingua scelta e scrive tour e risposte in quella lingua.

### Accessibilità (DSA e altre esigenze)
- Questionario su cosa aiuta: più schemi, frasi brevi, font ad alta leggibilità, meno testo per volta.
- Le risposte entrano nel contesto dell'agente.
- **Nessun caricamento di certificati**: sono dati sanitari (categoria particolare GDPR). Le risposte restano solo in locale.

## Stack

| Componente | Scelta |
| --- | --- |
| Linguaggio | TypeScript |
| App desktop | Tauri 2 (`src-tauri/`): solo la finestra del gioco, che cerca le sessioni sulle porte 7337-7356 (`GET /session`) e chiede quale seguire se sono più d'una |
| Grafica | DOM + canvas per sprite ed effetti; PixiJS o Phaser se servirà un motore |
| Server MCP | SDK ufficiale MCP per TypeScript v2 (`@modelcontextprotocol/server`): protocollo 2026-07-28 con ripiego sul 2025 |
| Tour | JSON in `.tour/` nel progetto spiegato (cartella da mettere nel `.gitignore`) |
| Audio | Web Audio API, suoni sintetizzati nel gioco (nessun file audio) |
| Impostazioni | SQLite (`node:sqlite`) nella cartella dati dell'utente; copia in localStorage per la demo |

## Roadmap

1. **Versione minima** ✅ editor pixelato, fumetto con ritratto, server MCP con `open_file`, `highlight_lines`, `show_dialog`.
2. **Tour** ✅ formato JSON, `.tour/`, riproduzione con animazioni, `create_tour`, `add_step`, diramazioni.
3. **Domande dal vivo** ✅ base: domanda nel gioco → `get_user_questions` → `show_dialog`. Notifica all'agente: canale di Claude Code (domande spinte nella sessione) e `wait_for_question` per gli altri agenti; coda dei fumetti. Cronologia: conversazioni salvate in `.tour/conversazioni/`, elenco "Domande" nel gioco per rileggerle (con gli schemi disegnati nelle risposte sotto ciascuna), seguiti con le domande e risposte precedenti, strumento `get_conversation`.
   - Un testo incollato di oltre 2000 caratteri diventa un allegato rimovibile. Ogni clic su «Chiedi alla guida», «Allega selezione» o «Incolla output terminale» aggiunge una sezione alla lista della domanda, anche per una sola riga. Ogni sezione si può togliere singolarmente. L’agente legge le sezioni in ordine, con file e righe per il codice. Si può continuare a scrivere, incollare altro testo o inviare solo il log. Fino a 5 MiB di testo per domanda, leggibile dall’agente per parti anche nella cronologia.
   - Nel campo delle domande si possono incollare fino a quattro immagini PNG, JPEG o WebP per un totale di 5 MB. Le miniature si possono rimuovere prima dell'invio. Si può inviare anche solo l'immagine. L'agente riceve gli allegati via MCP.
4. **Difficoltà** ✅ base: menu, cambio durante il tour, `set_step_text` per la modalità su richiesta. Da fare: preparazione in background del passo successivo.
5. **Lavagna** ✅ schemi JSON in `.tour/schemi/`, `draw_diagram`, `reveal_diagram`, `set_step_diagram`, rendering pixel con disegno progressivo, finestra a comparsa, scheda nell'editor, nodi che aprono il codice.
6. **Personalizzazione** ✅ ritratti predefiniti (Lumen, Aria, Patrizio, Nilo), nome della guida, upload convertito in pixel art nel browser (ritaglio, riduzione, k-means) con tre livelli di compressione affiancati e slider, espressioni automatiche (fumetto e colori) o caricate una per una. Il nome arriva all'agente nel contesto (`guide`). Da fare: bordi del fumetto alternativi.
7. **Accessibilità** ✅ questionario nel menu (7 aiuti, la dimensione del testo e una nota libera), salvataggio in SQLite tramite il ponte, condiviso tra progetti e finestre. Il gioco applica font Atkinson Hyperlegible, dimensione del testo (la stessa di A− / A+), meno animazioni e fumetto a pagine; le altre richieste arrivano all'agente in `get_game_state`, con le domande e nel prompt `crea_tour`. Nessun certificato.
8. **Suoni** ✅ quattro musiche chiptune a scelta (Taverna, Grotta di cristallo, Biblioteca, Forziere) o silenzio, effetti dell'interfaccia (passi, scelte, lavagna, domande, fine del tour) e voce della guida a bip mentre scrive, con un timbro per ritratto e un tono per espressione. Suono dei tasti mentre si scrive (domanda, editor, terminali): clic morbido da tastiera meccanica con un colpo grave, più pieno per Spazio e Invio, leggermente diverso a ogni tasto e più piano se il tasto resta premuto; si spegne dal menu. Tutto sintetizzato con Web Audio, senza file audio. Volumi separati, tasto M, salvati con le altre impostazioni.
9. **Lingue** ✅ interfaccia in inglese (predefinita) e italiano, scelta nel menu e salvata con le altre impostazioni. Testi in `src/game/i18n.ts`, cambio lingua senza ricaricare. La lingua arriva all'agente (`lang` in `get_game_state`, nelle domande e nel prompt `crea_tour`), che scrive tour e risposte in quella lingua. I tour già scritti restano nella loro lingua.
10. **Distribuzione** (in corso): niente pubblicazione su npm per ora (`private`); il pacchetto resta installabile dal sorgente ed è stato provato con `npm pack` con Codex CLI e Claude Code. App desktop Tauri in `src-tauri/`: finestra del gioco che trova da sola la sessione aperta e, con più sessioni, le elenca e lascia scegliere (anche nel browser, dal nome del progetto nella barra in alto); pacchetti deb e rpm provati su Fedora. Da fare: provarla su Windows e macOS.
11. **Modalità tutor** ✅ base (piano in `docs/tappa-11-tutor.md`): selettore Flusso/Tutor, editor modificabile con salvataggio (anche automatico prima di ogni domanda) e nuovo file. Le domande portano un estratto del codice dell'editor, le righe cambiate, l'output del terminale e l'ultimo scambio. Il tutor può recuperare altre righe della domanda e mostrare fumetto ed evidenziazione insieme. Scelte rapide (indizio, controllo, errore), prompt `tutor` con aiuti a livelli senza soluzione. `mark_lines` mette ondine e commenti che seguono le righe. Registro delle lacune in `.tour/lacune.json` con `record_gap` e `get_gaps`, pannello "Da ripassare" con Capito ed Esercizio. Da fare: eseguire il codice dal gioco (servirebbe una sandbox).
12. **Interfaccia da IDE** ✅
    - cartelle della barra laterale con icone pixel art che mostrano se sono aperte o chiuse. Partono chiuse. Il gioco ricorda quelle aperte per progetto e apre quelle del file mostrato;
    - in tutor, clic destro su un file in Esplora per rinominarlo o spostarlo nel Cestino del progetto. La scheda, la bozza e i segni seguono il nuovo nome. Il Cestino conserva la versione salvata e la ripristina al percorso originale, se libero;
    - Nuovo nella radice e clic destro su una cartella per creare un file o una sottocartella. Esplora mostra anche le cartelle vuote;
    - in tutor, trascina file e cartelle su una destinazione in Esplora. Le cartelle si possono spostare anche dal menu contestuale. Le sottocartelle, le schede, le bozze e i segni seguono il nuovo percorso. La cartella spostata risalta per un attimo. Una destinazione già occupata blocca lo spostamento;
    - **Annulla** in Esplora riporta al percorso originale l'ultimo elemento spostato in quella finestra, se il percorso è libero. Schede, bozze e segni seguono anche il ritorno.
    - Trova riferimenti dal menu dei file o dalla finestra Rinomina. Apre le righe con i riferimenti riconosciuti dal navigatore del codice, i passi dei tour e gli schemi che puntano al file;
    - più schede di file: Ctrl+clic (o clic centrale) nella barra apre una scheda nuova dopo la corrente, il clic semplice sostituisce la corrente (se non ha modifiche non salvate). Ogni scheda tiene buffer, scorrimento, righe evidenziate, segni di `mark_lines` e righe cambiate del tutor; `open_file` e i passi del tour portano in primo piano la scheda già aperta. Pallino ● su ogni scheda modificata; chiuderla (× o clic centrale) chiede Salva, Non salvare o Annulla;
    - Ctrl+clic nel codice sui file inclusi o importati (`#include "utils.h"`, `import`/`require` relativi, `from x import y` di Python, stringhe che sono percorsi di file): `follow.ts` cerca solo nell'elenco dei file del ponte, già confinato da `resolveInside()`. Le intestazioni di sistema (`#include <stdio.h>`), i pacchetti installati e i percorsi che escono dalla radice non si aprono.
    - righe da chiedere alla guida: clic su un numero di riga la sceglie, trascinamento o Maiusc+clic ne aggiungono altre (anche in tutor, dove la textarea copre il margine); il pulsante "Chiedi a <nome della guida>" compare accanto alla selezione, anche quella fatta dentro l'editor del tutor, e la cita nella domanda;
    - le schede Agente e Terminali permettono di passare dal codice o dalla chat a una vista a tutta altezza delle stesse shell. Allega selezione prepara il testo evidenziato nella domanda. Allega cronologia usa il buffer disponibile della sola shell attiva. L’agente riceve il testo quando l’utente invia la domanda;
    - pannello Terminali nella scheda Agente, anche in chat: Ctrl+` o "Terminali" nella barra di stato, + per altri, schede impilate a destra dell’output, bordo superiore trascinabile sopra il codice o lo storico e altezza salvata in `layout.ts`. Zoom + e Zoom − regolano il carattere di tutte le shell, anche nella scheda Terminali, con una preferenza locale. Shell vera nella cartella del progetto (`src/server/terminal.ts`, con `@lydell/node-pty` facoltativo e ripiego sulle pipe), xterm.js caricato solo al primo terminale e assente dalla demo. Solo per l'utente: l'agente non ha strumenti per usarli. `/term` accetta solo il gioco del ponte (stessa porta, app desktop, `npm run dev`), al massimo 8 shell, chiuse con il server; `--terminal off` o `CODE_DUNGEON_TERMINAL=0` li spengono.

    - campo della domanda su più righe: Invio manda, Maiusc+Invio va a capo, il campo cresce con il testo fino a 10 righe e poi scorre;

    - guida a destra dell'editor: un pulsante nella testata del fumetto la sposta in una colonna a tutta altezza, con divisore verticale (trascinamento, frecce, doppio clic) e scelta e larghezza salvate in `layout.ts`; il pannello Terminali si sovrappone al fondo dell’editor; nella chat e sotto i 760 px la guida torna sotto.

    Eseguire il codice per conto dell'agente resta legato alla sandbox della tappa 11.
13. **Formattazione delle risposte** ✅ base: `richtext.ts` costruisce con nodi DOM (mai `innerHTML`) paragrafi, a capo, elenchi (`- ` e `1. `), `codice`, blocchi ```linguaggio con i colori dell'editor e il pulsante Copia (unico HTML: le righe di `highlightLines`, già passate da `esc()`), `**grassetto**` e link, nel fumetto e nelle risposte della chat. La macchina da scrivere scrive dentro la formattazione, il fumetto a pagine taglia tra frasi e punti dell'elenco senza spezzare codice, indirizzi e numeri, il lettore di schermo riceve il testo con i punti dell'elenco. Le regole arrivano all'agente nella descrizione di `show_dialog` e nel prompt `crea_tour`. Link: nel browser in una scheda nuova, nell'app desktop il clic copia l'indirizzo. Da fare: aprirli nel browser di sistema dall'app (plugin opener di Tauri, permesso nuovo).

## Questioni aperte

- Elenco definitivo degli strumenti MCP e dei loro parametri per le tappe 6-7.
- Sprite e palette: disegnati a mano (oggi generati da codice) o con licenza libera.
- Fonti esterne per le risposte: strumenti di ricerca del client o strumenti del gioco.
- Più workspace nella stessa sessione. Oggi una radice per processo (`--project`, `CODE_DUNGEON_PROJECT` o cartella di avvio); più progetti solo con più sessioni sulle porte 7337-7356. Idea: `Project` con più radici, ognuna con `resolveInside()` e `.tour/`, parametro `workspace` negli strumenti, un albero per radice nella barra laterale. Nodi da sciogliere:
  - chi aggiunge una radice: dal browser allargherebbe l'accesso dell'agente, quindi `--project` ripetuto, file di configurazione o conferma salvata nello store;
  - le *roots* di MCP non si possono chiedere al client (niente richieste server → client, regola del doppio standard);
  - l'agente legge comunque solo dove il suo client gli dà il permesso.
