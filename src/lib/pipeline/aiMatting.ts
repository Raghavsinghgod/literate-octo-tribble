

import type { Cutout } from "./segment";

export type MattingResult = {

  alpha: Uint8ClampedArray;
  width: number;
  height: number;

  confidence: number;
};

type BackgroundRemovalPipeline = (
  image: ImageBitmap | string,
  options?: Record<string, unknown>,
) => Promise<Array<{ mask: CanvasImageSource & { width: number; height: number } }>>;

let pipePromise: Promise<BackgroundRemovalPipeline | null> | null = null;

export function loadMattingModel(): Promise<BackgroundRemovalPipeline | null> {
  if (!pipePromise) {
    pipePromise = (async () => {
      try {
        const { pipeline } = await import("@huggingface/transformers");
        const pipe = await pipeline("background-removal", "onnx-community/BiRefNet_lite-ONNX", {
          dtype: "fp32",
        });
        return pipe as unknown as BackgroundRemovalPipeline;
      } catch (err) {
        console.warn("BiRefNet model failed to load; using custom segmentation.", err);
        return null;
      }
    })();
  }
  return pipePromise;
}

export async function aiMatte(
  bitmap: ImageBitmap,
): Promise<MattingResult | null> {
  const pipe = await loadMattingModel();
  if (!pipe) return null;

  try {
    const result = await pipe(bitmap);
    const first = result[0];
    if (!first?.mask) return null;

    const srcW = bitmap.width;
    const srcH = bitmap.height;
    const cv = document.createElement("canvas");
    cv.width = srcW;
    cv.height = srcH;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(first.mask as unknown as CanvasImageSource, 0, 0, srcW, srcH);
    const maskData = ctx.getImageData(0, 0, srcW, srcH);

    const alpha = new Uint8ClampedArray(srcW * srcH * 4);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < srcW * srcH; i++) {
      const m = maskData.data[i * 4];
      const p = i * 4;

      alpha[p] = 0;
      alpha[p + 1] = 0;
      alpha[p + 2] = 0;
      alpha[p + 3] = m;
      if (m > 128) {
        sum += m;
        count++;
      }
    }

    return {
      alpha,
      width: srcW,
      height: srcH,
      confidence: count > 0 ? sum / count / 255 : 0,
    };
  } catch (err) {
    console.warn("BiRefNet inference failed; using custom segmentation.", err);
    return null;
  }
}

export function matteToCutout(
  source: { data: Uint8ClampedArray; width: number; height: number },
  matte: MattingResult,
): Cutout {
  const { width: w, height: h } = source;
  const n = w * h;
  const alpha = new Uint8ClampedArray(n * 4);
  const m = matte.alpha;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const a = m[p + 3];
    alpha[p] = source.data[p];
    alpha[p + 1] = source.data[p + 1];
    alpha[p + 2] = source.data[p + 2];
    alpha[p + 3] = a;
    if (a > 128) {
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    minX = 0; minY = 0; maxX = w - 1; maxY = h - 1;
  }

  return {
    alpha,
    width: w,
    height: h,
    softPixels: 0,
    touchedEdges: new Set<number>(),
    box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    candidates: [
      {
        box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
        area: (maxX - minX + 1) * (maxY - minY + 1),
        score: 1,
      },
    ],
    confidence: matte.confidence,
  };
}
