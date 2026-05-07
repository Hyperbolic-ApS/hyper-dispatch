import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "./password.js";

test("hashPassword and verifyPassword accept the correct password", () => {
  const hash = hashPassword("Nodes2020!");
  assert.equal(verifyPassword("Nodes2020!", hash), true);
});

test("verifyPassword rejects incorrect password", () => {
  const hash = hashPassword("Nodes2020!");
  assert.equal(verifyPassword("WrongPassword!", hash), false);
});
