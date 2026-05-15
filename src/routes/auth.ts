import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  clearSessionCookie,
  getAuthUser,
  SESSION_COOKIE_NAME,
  setSessionCookie,
} from "../auth/middleware.js";
import {
  createSession,
  createUserFromInvite,
  deleteSessionByToken,
  getUserByEmail,
  isInviteUsable,
  normalizeEmail,
  updateUserPassword,
} from "../auth/queries.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { escapeHtml } from "../utils/html.js";

export const authRouter = new Hono();

const CSS = `
  body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f9fafb; color: #111; }
  .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 24px; max-width: 520px; margin: 0 auto; }
  h1 { margin: 0 0 16px; font-size: 1.4rem; }
  .field { margin-bottom: 16px; }
  label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 4px; }
  input[type=text], input[type=email], input[type=password] { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; font-family: inherit; }
  .btn { display: inline-block; padding: 8px 18px; border-radius: 6px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; }
  .btn-primary { background: #3b82f6; color: #fff; }
  .btn-primary:hover { background: #2563eb; }
  .error { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; padding: 8px 10px; border-radius: 6px; margin-bottom: 12px; }
  .ok { background: #dcfce7; color: #166534; border: 1px solid #86efac; padding: 8px 10px; border-radius: 6px; margin-bottom: 12px; }
  .muted { color: #6b7280; font-size: 0.85rem; }
  a { color: #3b82f6; text-decoration: none; }
  a:hover { text-decoration: underline; }
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} — HyperDispatch</title>
  <style>${CSS}</style>
</head>
<body>
  ${body}
</body>
</html>`;
}

authRouter.get("/login", (c) => {
  const next = c.req.query("next") || "/dashboard";
  const error = c.req.query("error");
  const body = `
<div class="card">
  <h1>Sign in</h1>
  ${error ? '<div class="error">Invalid email or password.</div>' : ""}
  <form method="POST" action="/auth/login">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required>
    </div>
    <button class="btn btn-primary" type="submit">Sign in</button>
  </form>
</div>`;
  return c.html(page("Sign in", body));
});

authRouter.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const email = normalizeEmail(String(form.email ?? ""));
  const password = String(form.password ?? "");
  const next = String(form.next ?? "/dashboard");

  const user = await getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return c.redirect(`/auth/login?error=1&next=${encodeURIComponent(next)}`);
  }

  const { token, expiresAt } = await createSession(user.id);
  setSessionCookie(c, token, expiresAt);
  const safePath = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  return c.redirect(safePath);
});

authRouter.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE_NAME);
  if (token) {
    await deleteSessionByToken(token);
  }
  clearSessionCookie(c);
  return c.redirect("/auth/login");
});

authRouter.get("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const encodedToken = encodeURIComponent(token);
  const usable = await isInviteUsable(token);
  const error = c.req.query("error");
  const body = `
<div class="card">
  <h1>Create account</h1>
  ${!usable ? '<div class="error">This invite link is invalid or already used.</div>' : ""}
  ${error ? '<div class="error">Could not create account. Check input and try again.</div>' : ""}
  <form method="POST" action="/auth/invite/${escapeHtml(encodedToken)}">
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required ${usable ? "" : "disabled"}>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required minlength="8" ${usable ? "" : "disabled"}>
    </div>
    <button class="btn btn-primary" type="submit" ${usable ? "" : "disabled"}>Create account</button>
  </form>
</div>`;
  return c.html(page("Create account", body), usable ? 200 : 410);
});

authRouter.post("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const encodedToken = encodeURIComponent(token);
  const form = await c.req.parseBody();
  const email = normalizeEmail(String(form.email ?? ""));
  const password = String(form.password ?? "");
  if (!email || !password || password.length < 8) {
    return c.redirect(`/auth/invite/${encodedToken}?error=1`);
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    return c.redirect(`/auth/invite/${encodedToken}?error=1`);
  }

  const created = await createUserFromInvite({
    inviteToken: token,
    email,
    passwordHash: hashPassword(password),
  });
  if (!created) {
    return c.redirect(`/auth/invite/${encodedToken}?error=1`);
  }

  const { token: sessionToken, expiresAt } = await createSession(created.id);
  setSessionCookie(c, sessionToken, expiresAt);
  return c.redirect("/dashboard");
});

authRouter.get("/account", (c) => {
  const user = getAuthUser(c);
  const ok = c.req.query("ok");
  const error = c.req.query("error");
  const body = `
<div class="card">
  <h1>Account</h1>
  <p class="muted">Signed in as <strong>${escapeHtml(user?.email ?? "unknown")}</strong></p>
  ${ok ? '<div class="ok">Password updated.</div>' : ""}
  ${error ? '<div class="error">Password change failed.</div>' : ""}
  <form method="POST" action="/auth/change-password">
    <div class="field">
      <label for="current_password">Current password</label>
      <input type="password" id="current_password" name="current_password" required>
    </div>
    <div class="field">
      <label for="new_password">New password</label>
      <input type="password" id="new_password" name="new_password" required minlength="8">
    </div>
    <button class="btn btn-primary" type="submit">Change password</button>
  </form>
  <p style="margin-top:16px"><a href="/dashboard">Back to dashboard</a></p>
</div>`;
  return c.html(page("Account", body));
});

authRouter.post("/change-password", async (c) => {
  const user = getAuthUser(c);
  if (!user) {
    return c.redirect("/auth/login");
  }

  const form = await c.req.parseBody();
  const currentPassword = String(form.current_password ?? "");
  const newPassword = String(form.new_password ?? "");
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return c.redirect("/auth/account?error=1");
  }

  const fullUser = await getUserByEmail(user.email);
  if (!fullUser || !verifyPassword(currentPassword, fullUser.password_hash)) {
    return c.redirect("/auth/account?error=1");
  }

  await updateUserPassword(fullUser.id, hashPassword(newPassword));
  return c.redirect("/auth/account?ok=1");
});
