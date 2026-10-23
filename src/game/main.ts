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

async function createSource(): Promise<GameSource> {
  if (__DEMO__) {
    const { DemoSource } = await import("./demo-source");
    return new DemoSource();
  }
  // ?ponte=ws://127.0.0.1:7337/ws per cambiare indirizzo; servito dal ponte usa lo stesso host
  const params = new URLSearchParams(location.search);
  const fromBridge = location.port && location.port !== "5173" && location.protocol.startsWith("http");
  const url = params.get("ponte") ?? (fromBridge ? `ws://${location.host}/ws` : "ws://127.0.0.1:7337/ws");
  return new BridgeSource(url);
}

void createSource().then((source) => new App(source).boot());
