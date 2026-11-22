import { QUESTION_IMAGE_BYTES, QUESTION_IMAGE_TYPES, QUESTION_IMAGE_WIRE, QUESTION_IMAGES_MAX, type QuestionImage } from "../shared/types.js";

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function validateQuestionImages(input: unknown): QuestionImage[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > QUESTION_IMAGES_MAX) {
    throw new Error(`Allega da 1 a ${QUESTION_IMAGES_MAX} immagini.`);
  }
  let bytes = 0;
  return input.map((item) => {
    const { mimeType, data } = (item ?? {}) as Partial<QuestionImage>;
    if (!mimeType || !QUESTION_IMAGE_TYPES.includes(mimeType) || typeof data !== "string" ||
        data.length > QUESTION_IMAGE_WIRE || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new Error("Immagine non valida. Usa PNG, JPEG o WebP.");
    }
    const image = Buffer.from(data, "base64");
    bytes += image.length;
    if (bytes > QUESTION_IMAGE_BYTES) throw new Error("Le immagini superano il limite complessivo di 5 MB.");
    const valid = mimeType === "image/png" ? image.subarray(0, 8).equals(PNG_HEADER)
      : mimeType === "image/jpeg" ? image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
      : image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP";
    if (!valid) throw new Error("Il contenuto dell'immagine non corrisponde al formato dichiarato.");
    return { mimeType, data };
  });
}
