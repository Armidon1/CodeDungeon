// Schermo intero: nel browser con la Fullscreen API, nell'app desktop con la finestra di Tauri
// (la webview non porta la richiesta della pagina fino alla finestra su tutti i sistemi).

import { isDesktopApp } from "./source";

const appWindow = async () => (await import("@tauri-apps/api/window")).getCurrentWindow();

/** Il browser o l'app permettono lo schermo intero. */
export function fullscreenAvailable(): boolean {
  return isDesktopApp() || document.fullscreenEnabled;
}

export async function isFullscreen(): Promise<boolean> {
  if (isDesktopApp()) return (await appWindow()).isFullscreen();
  return document.fullscreenElement !== null;
}

/** Entra o esce dallo schermo intero. */
export async function toggleFullscreen(): Promise<void> {
  if (isDesktopApp()) {
    const win = await appWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
    return;
  }
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
}

/** cb riceve lo stato nuovo a ogni cambio, anche quando lo decide il sistema (Esc, F11 del browser). */
export function onFullscreenChange(cb: (on: boolean) => void): void {
  const check = () => void isFullscreen().then(cb, () => cb(false));
  if (isDesktopApp()) window.addEventListener("resize", check);
  else document.addEventListener("fullscreenchange", check);
  check();
}
