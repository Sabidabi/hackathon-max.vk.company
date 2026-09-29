// Photos are shrunk in the browser before upload. A phone photo is often 4–12 MB, and any
// proxy in front of the app may answer 413 above its own body limit (nginx default is 1 MB),
// so the file that leaves the phone is small enough for the strictest one.

export const UPLOAD_TARGET_BYTES = 900 * 1024;
const SIDES = [2000, 1600, 1280, 1024, 800];
const QUALITIES = [0.86, 0.76, 0.66];

interface Decoded {
  width: number;
  height: number;
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void;
  close: () => void;
}

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (context, width, height) => context.drawImage(bitmap, 0, 0, width, height),
        close: () => bitmap.close(),
      };
    } catch {
      // fall through to <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("decode"));
      element.src = url;
    });
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      draw: (context, width, height) => context.drawImage(image, 0, 0, width, height),
      close: () => undefined,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function renamed(file: File, extension: string): string {
  const base = file.name.replace(/\.[^.]+$/, "") || "photo";
  return `${base}.${extension}`;
}

/**
 * Returns a file that fits `maxBytes`: the original when it already does, otherwise a
 * downscaled JPEG (PNG for logos: they may be transparent). When the browser cannot decode the
 * file (for example HEIC) the original goes to the server, which explains what is wrong.
 */
export async function prepareImageForUpload(
  file: File,
  options: { kind?: "photo" | "logo"; maxBytes?: number } = {},
): Promise<File> {
  const maxBytes = options.maxBytes ?? UPLOAD_TARGET_BYTES;
  if (file.size <= maxBytes && (file.type === "image/jpeg" || file.type === "image/png")) return file;
  let decoded: Decoded;
  try {
    decoded = await decode(file);
  } catch {
    return file;
  }
  try {
    const logo = options.kind === "logo";
    const type = logo ? "image/png" : "image/jpeg";
    let best: Blob | null = null;
    for (const side of logo ? [512, 384, 256] : SIDES) {
      const scale = Math.min(1, side / Math.max(decoded.width, decoded.height));
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return file;
      if (!logo) {
        context.fillStyle = "#fff"; // JPEG has no alpha: transparent areas become white
        context.fillRect(0, 0, width, height);
      }
      decoded.draw(context, width, height);
      for (const quality of logo ? [1] : QUALITIES) {
        const blob = await toBlob(canvas, type, quality);
        if (!blob) continue;
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= maxBytes) return new File([blob], renamed(file, logo ? "png" : "jpg"), { type });
      }
    }
    return best ? new File([best], renamed(file, logo ? "png" : "jpg"), { type }) : file;
  } finally {
    decoded.close();
  }
}

/** The message for a body the server or a proxy in front of it refused as too large. */
export const TOO_LARGE_MESSAGE = "Файл слишком тяжёлый для сервера. Выберите фото поменьше.";
