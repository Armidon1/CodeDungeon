/** Un nome di file portabile per la rinomina, senza componenti di percorso. */
export function validRenameName(name: unknown): name is string {
  return typeof name === "string"
    && /^[^\\/:*?"<>|\x00-\x1f]{1,128}$/.test(name)
    && !/[. ]$/.test(name)
    && !/^(?:\.git|\.tour)$/i.test(name)
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name);
}
