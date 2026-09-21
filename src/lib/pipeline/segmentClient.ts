import type { Cutout } from "./segment";
import { segment } from "./segment";

export type SegInput = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  tolerance?: number;
  noRetry?: boolean;
};

type WorkerResult = {
  id: number;
  ok: boolean;
  error?: string;
  alpha?: ArrayBuffer;
  width: number;
  height: number;
  softPixels: number;
  touchedEdges: number[];
  box: Cutout["box"];
  candidates: Cutout["candidates"];
  confidence: number;
};

type PendingEntry = {
  input: SegInput;
  resolve: (c: Cutout) => void;
  reject: (e: Error) => void;
};

let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, PendingEntry>();

function runSync(input: SegInput): Cutout {
  return segment(input.rgba, input.width, input.height, {
    tolerance: input.tolerance,
    noRetry: input.noRetry,
  });
}

function drainPendingToSync() {
  const entries = [...pending.values()];
  pending.clear();
  for (const { input, resolve, reject } of entries) {
    try {
      resolve(runSync(input));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  try {
    const w = new Worker(new URL("./segmentWorker.ts", import.meta.url), {
      type: "module",
    });
    w.addEventListener("message", (e: MessageEvent) => {
      const res = e.data as WorkerResult;
      const entry = pending.get(res.id);
      if (!entry) return;
      pending.delete(res.id);
      if (!res.ok || !res.alpha) {
        try {
          entry.resolve(runSync(entry.input));
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      entry.resolve({
        alpha: new Uint8ClampedArray(res.alpha),
        width: res.width,
        height: res.height,
        softPixels: res.softPixels,
        touchedEdges: new Set(res.touchedEdges),
        box: res.box,
        candidates: res.candidates ?? [],
        confidence: res.confidence,
      });
    });
    w.addEventListener("error", () => {
      worker = null;
      w.terminate();
      drainPendingToSync();
    });
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

export function segmentAsync(input: SegInput): Promise<Cutout> {
  const w = getWorker();
  if (!w) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(runSync(input));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }, 30);
    });
  }

  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { input, resolve, reject });
    try {
      const copy = input.rgba.slice().buffer as ArrayBuffer;
      w.postMessage(
        {
          id,
          buffer: copy,
          width: input.width,
          height: input.height,
          tolerance: input.tolerance ?? 26,
          noRetry: input.noRetry ?? false,
        },
        [copy],
      );
    } catch (err) {
      pending.delete(id);
      worker = null;
      try {
        resolve(runSync(input));
      } catch (syncErr) {
        reject(syncErr instanceof Error ? syncErr : new Error(String(syncErr)));
      }
      void err;
    }
  });
}
