import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  STORAGE_DIR,
  STORAGE_SECRET,
  PUBLIC_API_URL,
  SIGNED_URL_TTL_MS,
} from "../config";

export type StorageOp = "GET" | "PUT";

export function sanitizeKey(key: string): string {
  if (!key || key.includes("..") || key.startsWith("/")) {
    throw new Error("Invalid storage key");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) {
    throw new Error("Invalid storage key characters");
  }
  return key;
}

export function objectPath(key: string): string {
  return join(STORAGE_DIR, "objects", sanitizeKey(key));
}

function hmac(payload: string): string {
  return createHmac("sha256", STORAGE_SECRET).update(payload).digest("hex");
}

export function signUrl(op: StorageOp, key: string): string {
  const safeKey = sanitizeKey(key);
  const exp = Date.now() + SIGNED_URL_TTL_MS;
  const sig = hmac(`${op}:${safeKey}:${exp}`);
  return `${PUBLIC_API_URL}/storage/${op}/${encodeURIComponent(safeKey)}?exp=${exp}&sig=${sig}`;
}

export function verifySignature(
  op: StorageOp,
  key: string,
  exp: string,
  sig: string,
): boolean {
  try {
    const expected = hmac(`${op}:${key}:${exp}`);
    const now = Date.now();
    const expMs = Number(exp);
    if (!Number.isFinite(expMs) || expMs < now) return false;
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(sig, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function writeObject(key: string, data: Uint8Array | string): Promise<void> {
  const path = objectPath(key);
  mkdirSync(join(path, ".."), { recursive: true });
  await Bun.write(path, data);
}

export async function readObject(key: string): Promise<Buffer | null> {
  const path = objectPath(key);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return Buffer.from(await file.arrayBuffer());
}

export async function objectExists(key: string): Promise<boolean> {
  return await Bun.file(objectPath(key)).exists();
}

export function objectFile(key: string): ReturnType<typeof Bun.file> {
  return Bun.file(objectPath(key));
}

export function objectFilePath(key: string): string {
  return objectPath(key);
}

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".jsonl": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".onnx": "application/octet-stream",
};

export function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return MIME[key.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

export function signedUrlPublicBase(): string {
  return process.env.STORAGE_PUBLIC_BASE ?? PUBLIC_API_URL;
}

export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] === "" ? NaN : Number(match[1]);
  let end = match[2] === "" ? NaN : Number(match[2]);
  if (Number.isNaN(start)) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (Number.isNaN(end)) end = size - 1;
  }
  if (start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

export { SIGNED_URL_TTL_MS };
