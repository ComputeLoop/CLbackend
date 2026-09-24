export const CLAIM_TTL_MS = Number(process.env.WORKER_LEASE_MS ?? 15 * 60 * 1000);
export const MAX_FAIL_ATTEMPTS = Number(process.env.MAX_FAIL_ATTEMPTS ?? 3);
export const STORAGE_DIR = process.env.STORAGE_DIR ?? "./storage";
export const STORAGE_SECRET = process.env.STORAGE_SECRET ?? "dev-storage-secret-change-me";
export const PUBLIC_API_URL = (process.env.PUBLIC_API_URL ?? "http://localhost:6767").replace(/\/$/, "");
export const SIGNED_URL_TTL_MS = Number(process.env.SIGNED_URL_TTL_MS ?? 30 * 60 * 1000);
export const DB_PATH = process.env.DB_PATH ?? "./computeloop.db";
export const PORT = Number(process.env.PORT ?? 6767);
export const HOSTNAME = process.env.HOSTNAME ?? "0.0.0.0";
export const CORS_ORIGINS = [
  "http://localhost:5173",
  "https://clfrontend-eight.vercel.app",
];
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
