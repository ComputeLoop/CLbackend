import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

const sqlite = new Database("/data/computeloop.db");

export const db = drizzle(sqlite);