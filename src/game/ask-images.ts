import { QUESTION_IMAGE_BYTES, QUESTION_IMAGE_TYPES, QUESTION_IMAGES_MAX, type QuestionImage, type QuestionImageType } from "../shared/types";
import { t } from "./i18n";

interface Attachment {
  file: File;
  mimeType: QuestionImageType;
  url: string;
}

export class AskImages {
  private items: Attachment[] = [];
  private busy = false;

  constructor(private list: HTMLElement, private status: HTMLElement) {}

  get count(): number {
    return this.items.length;
  }

  paste(event: ClipboardEvent): void {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const files = Array.from(clipboard.files).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    if (this.busy) return;
    if (files.some((file) => !file.size || !QUESTION_IMAGE_TYPES.some((mime) => file.type === mime))) {
      this.message(t().msg.askImageFormat);
      return;
    }
    if (this.items.length + files.length > QUESTION_IMAGES_MAX) {
      this.message(t().msg.askImageCountLimit(QUESTION_IMAGES_MAX));
      return;
    }
    const size = this.items.reduce((total, { file }) => total + file.size, 0) + files.reduce((total, file) => total + file.size, 0);
    if (size > QUESTION_IMAGE_BYTES) {
      this.message(t().msg.askImageSizeLimit(QUESTION_IMAGE_BYTES / (1024 * 1024)));
      return;
    }
    for (const file of files) this.items.push({ file, mimeType: file.type as QuestionImageType, url: URL.createObjectURL(file) });
    this.message("");
    this.render();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    for (const button of this.list.querySelectorAll("button")) button.disabled = busy;
  }

  message(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  clear(): void {
    for (const item of this.items) URL.revokeObjectURL(item.url);
    this.items = [];
    this.message("");
    this.render();
  }

  encode(): Promise<QuestionImage[]> {
    return Promise.all(this.items.map(({ file, mimeType }) => new Promise<QuestionImage>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error(t().msg.askImageReadFailed));
      reader.onabort = () => reject(new Error(t().msg.askImageReadFailed));
      reader.onload = () => {
        const data = typeof reader.result === "string" ? reader.result.split(",", 2)[1] : undefined;
        if (data) resolve({ mimeType, data });
        else reject(new Error(t().msg.askImageReadFailed));
      };
      reader.readAsDataURL(file);
    })));
  }

  render(): void {
    this.list.replaceChildren();
    this.list.hidden = !this.items.length;
    this.items.forEach((item, index) => {
      const row = document.createElement("li");
      const image = document.createElement("img");
      image.src = item.url;
      image.alt = t().ui.askImagePreview(index + 1);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-btn";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", t().ui.removeAskImage(index + 1));
      remove.disabled = this.busy;
      remove.addEventListener("click", () => {
        if (this.busy) return;
        this.items.splice(index, 1);
        URL.revokeObjectURL(item.url);
        this.message("");
        this.render();
        document.getElementById("ask-input")?.focus();
      });
      row.append(image, remove);
      this.list.append(row);
    });
  }
}
