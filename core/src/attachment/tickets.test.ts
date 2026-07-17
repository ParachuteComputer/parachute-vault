import { describe, test, expect } from "bun:test";
import { computeTicketTtlMs, generateTicketId, MAX_TICKET_UPLOAD_BYTES } from "./tickets.ts";

describe("computeTicketTtlMs — Aaron-ratified TTL scaling (10 min base + 10s/MiB, 30 min cap)", () => {
  test("no declared size → base TTL (10 minutes)", () => {
    expect(computeTicketTtlMs()).toBe(10 * 60 * 1000);
  });

  test("zero or negative size → base TTL (fails safe, not zero-TTL)", () => {
    expect(computeTicketTtlMs(0)).toBe(10 * 60 * 1000);
    expect(computeTicketTtlMs(-5)).toBe(10 * 60 * 1000);
  });

  test("1 MiB declared → base + 10s", () => {
    expect(computeTicketTtlMs(1024 * 1024)).toBe(10 * 60 * 1000 + 10 * 1000);
  });

  test("10 MiB declared → base + 100s", () => {
    expect(computeTicketTtlMs(10 * 1024 * 1024)).toBe(10 * 60 * 1000 + 100 * 1000);
  });

  test("100 MiB declared (under the cap's crossover at 120 MiB) is base + 1000s, not yet capped", () => {
    expect(computeTicketTtlMs(100 * 1024 * 1024)).toBe(10 * 60 * 1000 + 1000 * 1000);
  });

  test("a declared size past the crossover point (200 MiB) is capped at 30 minutes flat", () => {
    expect(computeTicketTtlMs(200 * 1024 * 1024)).toBe(30 * 60 * 1000);
  });
});

describe("generateTicketId", () => {
  test("is a 64-char hex string (256 bits)", () => {
    const id = generateTicketId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is unique across many calls (no Math.random-grade collisions)", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateTicketId()));
    expect(ids.size).toBe(1000);
  });
});

test("MAX_TICKET_UPLOAD_BYTES mirrors REST's 100 MiB upload ceiling", () => {
  expect(MAX_TICKET_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
});
