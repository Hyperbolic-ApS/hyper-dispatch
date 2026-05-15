import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "../db/connection.js";

export type UserRole = "admin" | "member";

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: Date;
  updated_at: Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

interface InviteRow {
  id: string;
  token_hash: string;
  created_by_user_id: string;
  used_by_user_id: string | null;
  used_at: Date | null;
  created_at: Date;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  const rows = await sql<UserRecord[]>`
    SELECT *
    FROM users
    WHERE email = ${normalizeEmail(email)}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  const rows = await sql<UserRecord[]>`
    SELECT *
    FROM users
    WHERE id = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listUsers(): Promise<UserRecord[]> {
  return sql<UserRecord[]>`
    SELECT *
    FROM users
    ORDER BY created_at ASC
  `;
}

export async function createUser(params: {
  email: string;
  passwordHash: string;
  role?: UserRole;
}): Promise<UserRecord> {
  const rows = await sql<UserRecord[]>`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (
      ${randomUUID()},
      ${normalizeEmail(params.email)},
      ${params.passwordHash},
      ${params.role ?? "member"}
    )
    RETURNING *
  `;
  return rows[0]!;
}

export async function updateUserPassword(
  userId: string,
  passwordHash: string
): Promise<void> {
  await sql`
    UPDATE users
    SET password_hash = ${passwordHash}, updated_at = NOW()
    WHERE id = ${userId}
  `;
}

export async function updateUserRole(
  userId: string,
  role: UserRole
): Promise<void> {
  await sql`
    UPDATE users
    SET role = ${role}, updated_at = NOW()
    WHERE id = ${userId}
  `;
}

export async function deleteUser(userId: string): Promise<void> {
  await sql`
    DELETE FROM users
    WHERE id = ${userId}
  `;
}

export async function createSession(
  userId: string
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

  await sql`
    INSERT INTO sessions (id, user_id, token_hash, expires_at)
    VALUES (
      ${randomUUID()},
      ${userId},
      ${hashToken(token)},
      ${expiresAt.toISOString()}
    )
  `;

  return { token, expiresAt };
}

export async function getUserBySessionToken(
  token: string
): Promise<UserRecord | null> {
  const rows = await sql<UserRecord[]>`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hashToken(token)}
      AND s.expires_at > NOW()
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function deleteSessionByToken(token: string): Promise<void> {
  await sql`
    DELETE FROM sessions
    WHERE token_hash = ${hashToken(token)}
  `;
}

export async function deleteSessionsForUser(userId: string): Promise<void> {
  await sql`
    DELETE FROM sessions
    WHERE user_id = ${userId}
  `;
}

export async function createInvite(
  createdByUserId: string
): Promise<{ token: string }> {
  const token = randomBytes(32).toString("hex");

  await sql`
    INSERT INTO invite_links (id, token_hash, created_by_user_id)
    VALUES (
      ${randomUUID()},
      ${hashToken(token)},
      ${createdByUserId}
    )
  `;

  return { token };
}

export async function isInviteUsable(token: string): Promise<boolean> {
  const rows = await sql<InviteRow[]>`
    SELECT *
    FROM invite_links
    WHERE token_hash = ${hashToken(token)}
      AND used_at IS NULL
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function createUserFromInvite(params: {
  inviteToken: string;
  email: string;
  passwordHash: string;
}): Promise<UserRecord | null> {
  const inviteHash = hashToken(params.inviteToken);

  return sql.begin(async (tx) => {
    const inviteRows = await tx<InviteRow[]>`
      SELECT *
      FROM invite_links
      WHERE token_hash = ${inviteHash}
        AND used_at IS NULL
      LIMIT 1
      FOR UPDATE
    `;
    const invite = inviteRows[0];
    if (!invite) return null;

    const userRows = await tx<UserRecord[]>`
      INSERT INTO users (id, email, password_hash, role)
      VALUES (
        ${randomUUID()},
        ${normalizeEmail(params.email)},
        ${params.passwordHash},
        'member'
      )
      RETURNING *
    `;
    const user = userRows[0]!;

    await tx`
      UPDATE invite_links
      SET used_at = NOW(), used_by_user_id = ${user.id}
      WHERE id = ${invite.id}
        AND used_at IS NULL
    `;

    return user;
  });
}

export async function ensureAdminUserSeeded(params: {
  email: string;
  passwordHash: string;
}): Promise<void> {
  const existing = await getUserByEmail(params.email);
  if (existing) {
    if (existing.role !== "admin") {
      await updateUserRole(existing.id, "admin");
    }
    return;
  }

  await createUser({
    email: params.email,
    passwordHash: params.passwordHash,
    role: "admin",
  });
}
