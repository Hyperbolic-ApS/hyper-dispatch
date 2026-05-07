import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getUserBySessionToken } from "./queries.js";

export const SESSION_COOKIE_NAME = "hd_session";

export interface AuthUser {
  id: string;
  email: string;
  role: "admin" | "member";
}

function isApiRequest(c: Context): boolean {
  return c.req.path.startsWith("/api");
}

function unauthorized(c: Context): Response {
  if (isApiRequest(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const next = encodeURIComponent(c.req.path);
  return c.redirect(`/auth/login?next=${next}`);
}

export async function authMiddleware(c: Context, next: Next): Promise<void> {
  const sessionToken = getCookie(c, SESSION_COOKIE_NAME);
  if (!sessionToken) {
    return next();
  }

  const user = await getUserBySessionToken(sessionToken);
  if (!user) {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return next();
  }

  c.set("authUser", {
    id: user.id,
    email: user.email,
    role: user.role,
  } satisfies AuthUser);

  await next();
}

export function getAuthUser(c: Context): AuthUser | undefined {
  return c.get("authUser") as AuthUser | undefined;
}

export async function requireAuth(
  c: Context,
  next: Next
): Promise<Response | void> {
  const sessionToken = getCookie(c, SESSION_COOKIE_NAME);
  if (!sessionToken) {
    return unauthorized(c);
  }

  const user = await getUserBySessionToken(sessionToken);
  if (!user) {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return unauthorized(c);
  }

  c.set("authUser", {
    id: user.id,
    email: user.email,
    role: user.role,
  } satisfies AuthUser);

  await next();
}

export async function requireAdmin(
  c: Context,
  next: Next
): Promise<Response | void> {
  const user = getAuthUser(c);
  if (!user) {
    return unauthorized(c);
  }
  if (user.role !== "admin") {
    if (isApiRequest(c)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return c.text("Forbidden", 403);
  }
  await next();
}

export function setSessionCookie(
  c: Context,
  token: string,
  expiresAt: Date
): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
}