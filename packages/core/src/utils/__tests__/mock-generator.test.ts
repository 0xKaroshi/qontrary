import { describe, it, expect } from "vitest";
import { detectApis, generateMocks, renderMockInstructions } from "../mock-generator.js";

describe("detectApis", () => {
  it("detects CoinGecko from description", () => {
    const apis = detectApis({
      description: "Fetch Bitcoin price from CoinGecko",
      stack: ["node"],
      acceptance_criteria: ["logs BTC price"],
    });
    expect(apis).toContain("coingecko");
  });

  it("detects Helius from acceptance criteria", () => {
    const apis = detectApis({
      description: "Solana wallet CLI",
      stack: ["typescript"],
      acceptance_criteria: ["uses Helius API to fetch token balances"],
    });
    expect(apis).toContain("helius");
  });

  it("detects DexScreener from description", () => {
    const apis = detectApis({
      description: "Scrape trending tokens from DexScreener",
      stack: ["node"],
      acceptance_criteria: ["returns top 10 tokens"],
    });
    expect(apis).toContain("dexscreener");
  });

  it("detects Express/localhost for supertest-based tests", () => {
    const apis = detectApis({
      description: "Express API with health endpoint",
      stack: ["express", "supertest"],
      acceptance_criteria: ["GET /health returns 200"],
    });
    expect(apis).toContain("express_local");
  });

  it("returns empty array when no known APIs matched", () => {
    const apis = detectApis({
      description: "Sort an array of numbers",
      stack: ["node"],
      acceptance_criteria: ["returns sorted array"],
    });
    expect(apis).toEqual([]);
  });

  it("detects multiple APIs in one spec", () => {
    const apis = detectApis({
      description: "Dashboard showing CoinGecko prices and DexScreener trending",
      stack: ["node"],
      acceptance_criteria: ["fetches from CoinGecko", "scrapes DexScreener"],
    });
    expect(apis).toContain("coingecko");
    expect(apis).toContain("dexscreener");
  });
});

describe("generateMocks", () => {
  it("returns valid mock spec for CoinGecko", () => {
    const mocks = generateMocks({
      description: "Fetch Bitcoin price from CoinGecko",
      stack: ["node"],
      acceptance_criteria: [],
    });
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.service).toBe("CoinGecko");
    expect(mocks[0]!.endpoints.length).toBeGreaterThan(0);
    const ep = mocks[0]!.endpoints[0]!;
    expect(ep.status).toBe(200);
    expect(ep.body).toHaveProperty("bitcoin");
    const btc = ep.body as Record<string, Record<string, number>>;
    expect(btc["bitcoin"]!["usd"]).toBeTypeOf("number");
  });

  it("returns valid mock spec for Helius", () => {
    const mocks = generateMocks({
      description: "Solana wallet via Helius",
      stack: ["typescript"],
      acceptance_criteria: ["uses Helius API"],
    });
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.service).toBe("Helius");
    const ep = mocks[0]!.endpoints[0]!;
    expect(ep.urlPattern).toContain("helius");
    expect(ep.body).toHaveProperty("jsonrpc");
  });

  it("returns empty array for no-network spec", () => {
    const mocks = generateMocks({
      description: "Sort numbers",
      stack: ["node"],
      acceptance_criteria: [],
    });
    expect(mocks).toHaveLength(0);
  });
});

describe("renderMockInstructions", () => {
  it("returns empty string when no mocks", () => {
    expect(renderMockInstructions([])).toBe("");
  });

  it("includes MANDATORY header and mock data for detected APIs", () => {
    const mocks = generateMocks({
      description: "Fetch from CoinGecko",
      stack: ["node"],
      acceptance_criteria: [],
    });
    const text = renderMockInstructions(mocks);
    expect(text).toContain("NETWORK MOCKING (MANDATORY");
    expect(text).toContain("NEVER make real network requests");
    expect(text).toContain("CoinGecko");
    expect(text).toContain("67432.12");
  });

  it("includes supertest instruction for Express mocks", () => {
    const mocks = generateMocks({
      description: "Express API",
      stack: ["express"],
      acceptance_criteria: [],
    });
    const text = renderMockInstructions(mocks);
    expect(text).toContain("supertest");
  });
});
