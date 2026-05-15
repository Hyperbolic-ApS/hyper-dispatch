import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";
describe("password helpers", () => {
  it("accepts the correct password", () => {
    const hash = hashPassword("CorrectHorseBatteryStaple!");
    expect(verifyPassword("CorrectHorseBatteryStaple!", hash)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const hash = hashPassword("CorrectHorseBatteryStaple!");
    expect(verifyPassword("WrongPassword!", hash)).toBe(false);
  });
});
