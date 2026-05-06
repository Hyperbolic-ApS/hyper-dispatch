import postgres from "postgres";
import { env } from "../config/env.js";

const isLocal =
  env.DATABASE_URL.includes("localhost") ||
  env.DATABASE_URL.includes("127.0.0.1");

export const sql = postgres(env.DATABASE_URL, {
  ssl: isLocal ? false : "require",
});
