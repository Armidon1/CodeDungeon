// Finestra del gioco: carica dist/game; il gioco cerca da solo il ponte su 127.0.0.1:7337-7356.
// Il server resta quello avviato dall'agente (MCP) o da `npm run play`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK con pulsesink smette di suonare dopo mezzo secondo (il contesto audio resta "running"):
    // si preferisce pipewiresink. Se manca, GStreamer ripiega da solo; una scelta dell'utente vince.
    #[cfg(target_os = "linux")]
    if std::env::var_os("GST_PLUGIN_FEATURE_RANK").is_none() {
        std::env::set_var("GST_PLUGIN_FEATURE_RANK", "pipewiresink:MAX");
    }
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("avvio di Code Dungeon fallito");
}
