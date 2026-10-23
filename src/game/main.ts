import "@fontsource/press-start-2p/latin-400.css";
import "@fontsource/pixelify-sans/latin-400.css";
import "@fontsource/pixelify-sans/latin-600.css";
import "@fontsource/vt323/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/atkinson-hyperlegible-mono/latin-400.css";
import "./styles.css";
import { App } from "./app";
import { BridgeSource, type GameSource } from "./source";
import { resolveBridge, servedByBridge } from "./sessions";

async function createSource(): Promise<GameSource> {
  if (__DEMO__) {
    const { DemoSource } = await import("./demo-source");
    return new DemoSource();
  }
  // ?ponte=ws://127.0.0.1:7337/ws per cambiare indirizzo; servito dal ponte usa lo stesso host
  const params = new URLSearchParams(location.search);
  const ponte = params.get("ponte");
  if (ponte) return new BridgeSource(ponte);
  if (servedByBridge()) return new BridgeSource(`ws://${location.host}/ws`);
  // App desktop e `npm run dev`: cerca le sessioni aperte a ogni tentativo e, se sono più d'una, chiede quale
  return new BridgeSource(resolveBridge);
}

void createSource().then((source) => new App(source).boot());
