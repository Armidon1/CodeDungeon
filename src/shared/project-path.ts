/** Indica se il percorso è la cartella stessa o una voce al suo interno. */
export function directoryContains(dir: string, path: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

export function repathDirectory(path: string, from: string, to: string): string {
  return directoryContains(from, path) ? to + path.slice(from.length) : path;
}

/** Cartella che contiene la voce, o stringa vuota per la radice. */
export function parentDirectory(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}
