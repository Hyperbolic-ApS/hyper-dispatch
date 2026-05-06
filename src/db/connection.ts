import postgres from "postgres";
import { env } from "../config/env.js";

export const sql = postgres(env.DATABASE_URL);
