// Finestra del gioco: carica dist/game; il gioco cerca da solo il ponte su 127.0.0.1:7337-7356.
// Il server resta quello avviato dall'agente (MCP) o da `npm run play`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("avvio di Code Dungeon fallito");
}
