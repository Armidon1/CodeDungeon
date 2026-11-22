import type { GameSource } from "./source";
import { followKnownTarget, projectLink } from "./follow";

export interface FileReferences {
  code: { file: string; line: number; text: string }[];
  tours: { id: string; title: string; step: string; label: string }[];
  diagrams: { id: string; title: string; node: string }[];
  moreCode: boolean;
}

const MAX_CODE_RESULTS = 200;

export async function findFileReferences(
  source: GameSource,
  drafts: ReadonlyMap<string, string>,
  target: string,
  signal: AbortSignal,
): Promise<FileReferences> {
  const known = new Set(source.files);
  const codeFiles = source.files.filter((file) => file !== target);
  const result: FileReferences = { code: [], tours: [], diagrams: [], moreCode: false };
  const searchCode = async () => {
    for (let i = 0; i < codeFiles.length; i += 8) {
      signal.throwIfAborted();
      const batch = codeFiles.slice(i, i + 8);
      const texts = await Promise.all(batch.map(async (file) => drafts.get(file) ?? await source.readFile(file).catch(() => "")));
      for (const [index, text] of texts.entries()) {
        const file = batch[index];
        for (const [offset, line] of text.split("\n").entries()) {
          if (followKnownTarget(line, file, known) !== target) continue;
          if (result.code.length === MAX_CODE_RESULTS) {
            result.moreCode = true;
            return;
          }
          result.code.push({ file, line: offset + 1, text: line.trim().slice(0, 280) });
        }
      }
    }
  };
  const searchTours = async () => {
    for (const { id } of await source.listTours()) {
      signal.throwIfAborted();
      const tour = await source.loadTour(id);
      for (const step of tour.steps) {
        if (typeof step.file === "string" && projectLink(step.file) === target) {
          result.tours.push({ id, title: tour.title, step: step.id, label: step.title ?? step.id });
        }
      }
    }
  };
  const searchDiagrams = async () => {
    for (const { id } of await source.listDiagrams()) {
      signal.throwIfAborted();
      const diagram = await source.loadDiagram(id);
      for (const node of diagram.nodes) {
        if (node.code && typeof node.code.file === "string" && projectLink(node.code.file) === target) {
          result.diagrams.push({ id, title: diagram.title, node: node.label });
        }
      }
    }
  };
  await Promise.all([searchCode(), searchTours(), searchDiagrams()]);
  return result;
}
