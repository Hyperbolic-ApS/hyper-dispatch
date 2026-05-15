import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { setSessionCookie } from "./middleware.js";

const originalNodeEnv = process.env.NODE_ENV;

describe("setSessionCookie", () => {
  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("sets the Secure flag in production", async () => {
    process.env.NODE_ENV = "production";

    const app = new Hono();
    app.get("/", (c) => {
      setSessionCookie(
        c,
        "session-token",
        new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
      );
      return c.text("ok");
    });

    const res = await app.request("http://localhost/");

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
});
