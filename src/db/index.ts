import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { DB_PATH } from "../config";

export const sqlite = new Database(DB_PATH);
export const db = drizzle(sqlite);