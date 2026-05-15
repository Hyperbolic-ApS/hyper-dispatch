import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createSessionMock = vi.fn();
const createUserFromInviteMock = vi.fn();
const deleteSessionByTokenMock = vi.fn();
const getUserByEmailMock = vi.fn();
const isInviteUsableMock = vi.fn();
const updateUserPasswordMock = vi.fn();
const hashPasswordMock = vi.fn();
const verifyPasswordMock = vi.fn();

vi.mock("../auth/queries.js", () => ({
  createSession: createSessionMock,
  createUserFromInvite: createUserFromInviteMock,
  deleteSessionByToken: deleteSessionByTokenMock,
  getUserByEmail: getUserByEmailMock,
  isInviteUsable: isInviteUsableMock,
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
  updateUserPassword: updateUserPasswordMock,
}));

vi.mock("../auth/password.js", () => ({
  hashPassword: hashPasswordMock,
  verifyPassword: verifyPasswordMock,
}));

describe("authRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSessionMock.mockResolvedValue({
      token: "session-token",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    });
    hashPasswordMock.mockReturnValue("hashed-password");
    isInviteUsableMock.mockResolvedValue(true);
  });

  async function getApp(
    authUser:
      | { id: string; email: string; role: "admin" | "member" }
      | undefined = undefined
  ) {
    const { authRouter } = await import("./auth.js");
    const app = new Hono();
    app.use("*", async (c, next) => {
      if (authUser) {
        (c as any).set("authUser", authUser);
      }
      await next();
    });
    app.route("/auth", authRouter);
    return app;
  }

  it("escapes the next parameter in the login form", async () => {
    const app = await getApp();
    const res = await app.request(
      "http://localhost/auth/login?next=%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E"
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      'value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'
    );
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it("rejects protocol-relative next redirects after login", async () => {
    getUserByEmailMock.mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      password_hash: "stored-hash",
      role: "member",
    });
    verifyPasswordMock.mockReturnValue(true);
    const app = await getApp();

    const res = await app.request("http://localhost/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        email: "user@example.com",
        password: "password123",
        next: "//evil.com",
      }),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
  });

  it("invalidates the server-side session on logout", async () => {
    const app = await getApp();

    const res = await app.request("http://localhost/auth/logout", {
      method: "POST",
      headers: {
        cookie: "hd_session=old-session-token",
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
    expect(deleteSessionByTokenMock).toHaveBeenCalledWith("old-session-token");
  });

  it("rejects invite signups with short passwords", async () => {
    const app = await getApp();

    const res = await app.request("http://localhost/auth/invite/invite-token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        email: "new@example.com",
        password: "short",
      }),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/invite/invite-token?error=1");
    expect(createUserFromInviteMock).not.toHaveBeenCalled();
  });

  it("escapes the signed-in email on the account page", async () => {
    const app = await getApp({
      id: "user-1",
      email: '<img src=x onerror=alert(1)>',
      role: "member",
    });

    const res = await app.request("http://localhost/auth/account");

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it("rejects password changes with short new passwords", async () => {
    const app = await getApp({
      id: "user-1",
      email: "user@example.com",
      role: "member",
    });

    const res = await app.request("http://localhost/auth/change-password", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        current_password: "current-password",
        new_password: "short",
      }),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/account?error=1");
    expect(updateUserPasswordMock).not.toHaveBeenCalled();
  });
});
