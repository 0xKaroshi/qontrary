/**
 * Generates mock HTTP response data for known external APIs so that
 * Builder-generated test files can run without real network access.
 */

/** A single mock endpoint definition. */
export interface MockEndpoint {
  /** URL pattern or substring that triggers this mock. */
  urlPattern: string;
  /** HTTP method (default GET). */
  method: string;
  /** HTTP status code to return. */
  status: number;
  /** JSON body to return. */
  body: Record<string, unknown>;
}

/** A full mock specification for one external service. */
export interface ApiMockSpec {
  /** Human-readable service name. */
  service: string;
  /** Endpoints to mock. */
  endpoints: MockEndpoint[];
}

/** Registry of known APIs and their mock shapes. */
const KNOWN_APIS: Record<string, ApiMockSpec> = {
  coingecko: {
    service: "CoinGecko",
    endpoints: [
      {
        urlPattern: "api.coingecko.com/api/v3/simple/price",
        method: "GET",
        status: 200,
        body: {
          bitcoin: { usd: 67432.12, usd_24h_change: 2.34 },
          solana: { usd: 142.56, usd_24h_change: -1.12 },
          ethereum: { usd: 3456.78, usd_24h_change: 0.87 },
        },
      },
      {
        urlPattern: "api.coingecko.com/api/v3/coins/",
        method: "GET",
        status: 200,
        body: {
          id: "bitcoin",
          symbol: "btc",
          name: "Bitcoin",
          market_data: {
            current_price: { usd: 67432.12 },
            market_cap: { usd: 1_320_000_000_000 },
            total_volume: { usd: 28_500_000_000 },
          },
        },
      },
    ],
  },
  helius: {
    service: "Helius",
    endpoints: [
      {
        urlPattern: "api.helius.xyz",
        method: "POST",
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            total: 3,
            limit: 10,
            items: [
              { id: "So11111111111111111111111111111111111111112", content: { metadata: { name: "Wrapped SOL", symbol: "SOL" } }, token_info: { balance: 1_500_000_000, decimals: 9, price_info: { price_per_token: 142.56 } } },
              { id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", content: { metadata: { name: "USD Coin", symbol: "USDC" } }, token_info: { balance: 50_000_000, decimals: 6, price_info: { price_per_token: 1.0 } } },
              { id: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", content: { metadata: { name: "Tether", symbol: "USDT" } }, token_info: { balance: 25_000_000, decimals: 6, price_info: { price_per_token: 1.0 } } },
            ],
          },
        },
      },
      {
        urlPattern: "api.helius.xyz/v0/addresses",
        method: "GET",
        status: 200,
        body: {
          tokens: [
            { mint: "So11111111111111111111111111111111111111112", amount: 1500000000, decimals: 9, tokenAccount: "abc123" },
            { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: 50000000, decimals: 6, tokenAccount: "def456" },
          ],
        },
      },
    ],
  },
  dexscreener: {
    service: "DexScreener",
    endpoints: [
      {
        urlPattern: "api.dexscreener.com",
        method: "GET",
        status: 200,
        body: {
          pairs: [
            { baseToken: { name: "Pepe", symbol: "PEPE", address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933" }, priceUsd: "0.00001234", volume: { h24: 450_000_000 }, priceChange: { h24: 125.4 }, chainId: "ethereum" },
            { baseToken: { name: "Bonk", symbol: "BONK", address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" }, priceUsd: "0.00002891", volume: { h24: 320_000_000 }, priceChange: { h24: 89.2 }, chainId: "solana" },
            { baseToken: { name: "Floki", symbol: "FLOKI", address: "0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E" }, priceUsd: "0.00017823", volume: { h24: 210_000_000 }, priceChange: { h24: 45.6 }, chainId: "ethereum" },
            { baseToken: { name: "WIF", symbol: "WIF", address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" }, priceUsd: "2.34", volume: { h24: 180_000_000 }, priceChange: { h24: 34.1 }, chainId: "solana" },
            { baseToken: { name: "BOME", symbol: "BOME", address: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82" }, priceUsd: "0.00987", volume: { h24: 150_000_000 }, priceChange: { h24: 67.3 }, chainId: "solana" },
            { baseToken: { name: "MOG", symbol: "MOG", address: "0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a" }, priceUsd: "0.0000023", volume: { h24: 95_000_000 }, priceChange: { h24: 210.5 }, chainId: "ethereum" },
            { baseToken: { name: "POPCAT", symbol: "POPCAT", address: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr" }, priceUsd: "1.12", volume: { h24: 88_000_000 }, priceChange: { h24: 28.9 }, chainId: "solana" },
            { baseToken: { name: "BRETT", symbol: "BRETT", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4" }, priceUsd: "0.145", volume: { h24: 76_000_000 }, priceChange: { h24: 15.2 }, chainId: "base" },
            { baseToken: { name: "MEW", symbol: "MEW", address: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5" }, priceUsd: "0.0089", volume: { h24: 62_000_000 }, priceChange: { h24: 42.7 }, chainId: "solana" },
            { baseToken: { name: "TURBO", symbol: "TURBO", address: "0xA35923162C49cF95e6BF26623385eb431ad920D3" }, priceUsd: "0.0067", volume: { h24: 54_000_000 }, priceChange: { h24: 19.8 }, chainId: "ethereum" },
          ],
        },
      },
    ],
  },
  express_local: {
    service: "Express (localhost)",
    endpoints: [
      {
        urlPattern: "localhost",
        method: "GET",
        status: 200,
        body: { status: "ok", message: "mock response" },
      },
      {
        urlPattern: "localhost",
        method: "POST",
        status: 201,
        body: { id: 1, created: true },
      },
      {
        urlPattern: "localhost",
        method: "DELETE",
        status: 200,
        body: { deleted: true },
      },
    ],
  },
};

/** Aliases: common ways the model references a service. */
const ALIASES: Record<string, string> = {
  coingecko: "coingecko",
  "coin gecko": "coingecko",
  helius: "helius",
  "helius api": "helius",
  dexscreener: "dexscreener",
  "dex screener": "dexscreener",
  express: "express_local",
  supertest: "express_local",
  localhost: "express_local",
};

/**
 * Detect which external APIs a spec references by scanning the task
 * description, stack, and acceptance criteria.
 * @param spec SpecOutput-like fields
 * @returns matched service keys
 */
export function detectApis(spec: {
  description: string;
  stack: string[];
  acceptance_criteria: string[];
}): string[] {
  const haystack = [
    spec.description,
    ...spec.stack,
    ...spec.acceptance_criteria,
  ]
    .join(" ")
    .toLowerCase();

  const matched = new Set<string>();
  for (const [alias, key] of Object.entries(ALIASES)) {
    if (haystack.includes(alias)) {
      matched.add(key);
    }
  }
  return [...matched];
}

/**
 * Generate mock specifications for the APIs detected in a spec.
 * @param spec SpecOutput-like fields
 * @returns array of ApiMockSpec for each detected service
 */
export function generateMocks(spec: {
  description: string;
  stack: string[];
  acceptance_criteria: string[];
}): ApiMockSpec[] {
  const keys = detectApis(spec);
  const mocks: ApiMockSpec[] = [];
  for (const key of keys) {
    const mock = KNOWN_APIS[key];
    if (mock) mocks.push(mock);
  }
  return mocks;
}

/**
 * Render mock specifications as a concise instruction block that can be
 * injected into a Builder prompt for test-type tasks.
 * @param mocks array from generateMocks
 * @returns multi-line instruction string, or empty if no mocks
 */
export function renderMockInstructions(mocks: ApiMockSpec[]): string {
  if (mocks.length === 0) return "";

  const lines = [
    "\nNETWORK MOCKING (MANDATORY for test tasks):",
    "All test files MUST mock external HTTP calls. NEVER make real network requests from tests.",
    "Use one of these approaches (in order of preference):",
    "1. Override global fetch with a stub that returns canned responses",
    "2. Use jest.mock / vi.mock to replace the HTTP module",
    "3. Inject a mock HTTP client into the module under test",
    "",
    "Mock data for detected external APIs (use these exact response shapes):",
  ];

  for (const mock of mocks) {
    lines.push(`\n### ${mock.service}`);
    for (const ep of mock.endpoints) {
      lines.push(`  ${ep.method} ...${ep.urlPattern} → ${ep.status}`);
      lines.push(`  Response: ${JSON.stringify(ep.body, null, 2).split("\n").join("\n  ")}`);
    }
  }

  lines.push(
    "",
    "If no mock data above covers an endpoint your test needs, generate a realistic fixture inline.",
    "Tests that require a running server (Express/WebSocket) should use supertest or start the server in the test setup/teardown.",
  );

  return lines.join("\n");
}
