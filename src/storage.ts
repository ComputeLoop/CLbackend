/**
 * Object storage + capability (signed) URLs.
 *
 * Local filesystem backend for dev/campus. The interface is S3-shaped so a
 * MinIO/R2 backend can be dropped in later without touching route code.
 *
 * Signed URL format:
 *   <PUBLIC_API_URL>/storage/<GET|PUT>/<url-encoded key>?exp=<ms>&sig=<hmac>
 *   sig = HMAC-SHA256(STORAGE_SECRET, `${op}:${key}:${exp}`)
 *
 * A GET signature cannot be reused for PUT (op is part of the signed payload).
 */
import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const STORAGE_DIR = process.env.STORAGE_DIR ?? "./storage";
const STORAGE_SECRET =
  process.env.STORAGE_SECRET ?? "dev-storage-secret-change-me";
// Base URL the signed URLs are built against (same origin as the API in dev).
const PUBLIC_API_URL =
  process.env.PUBLIC_API_URL ?? "http://localhost:6767";

const SIGNED_URL_TTL_MS = Number(process.env.SIGNED_URL_TTL_MS ?? 30 * 60 * 1000);

export type StorageOp = "GET" | "PUT";

/** Reject traversal and weird keys; only allow [A-Za-z0-9._/-]. */
export function sanitizeKey(key: string): string {
  if (!key || key.includes("..") || key.startsWith("/")) {
    throw new Error("Invalid storage key");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) {
    throw new Error("Invalid storage key characters");
  }
  return key;
}

function objectPath(key: string): string {
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
  return (await Bun.file(objectPath(key)).exists());
}

/**
 * Direct handle to an object on disk (bypasses the signed URL layer).
 * Used by server-side code that has already checked authorization.
 */
export function objectFile(key: string): BunFile {
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

export { SIGNED_URL_TTL_MS };