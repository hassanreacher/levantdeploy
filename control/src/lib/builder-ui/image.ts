"use client";

/**
 * Reads an image as a data URI for chat attachments (builder-agents accepts https URLs or base64 data URIs ≤ 5 MB).
 * Large images are downscaled to `maxDim` px and re-encoded (JPEG/WebP) so prompts stay small; GIF/SVG are kept as is.
 */
export async function imageToDataUrl(file: File, maxDim = 1600, quality = 0.86): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("Could not read the image"));
    r.readAsDataURL(file);
  });
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return raw;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Unsupported image"));
    i.src = raw;
  });
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) return raw;
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  const type = file.type === "image/png" ? "image/webp" : "image/jpeg";
  return c.toDataURL(type, quality);
}
