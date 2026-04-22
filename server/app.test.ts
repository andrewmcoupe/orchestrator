import { describe, it, expect } from "vitest";
import { app } from "./app.js";

describe("healthz", () => {
  it("returns 200 with ok status", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});
