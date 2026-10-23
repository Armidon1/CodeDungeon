// In modalità MCP lo stdout è riservato al protocollo: i log vanno solo su stderr.
export function log(message: string): void {
  process.stderr.write(`[code-dungeon] ${message}\n`);
}
