import { describe, it, expect, vi } from "vitest";
import { E2BSandbox, type E2BSandboxLike } from "../e2b-runner.js";

/** Create a mock E2BSandboxLike with configurable command results. */
function createMockSandbox(overrides?: {
  commandResults?: Map<string, { stdout: string; stderr: string; exitCode: number }>;
  files?: Map<string, string>;
}): E2BSandboxLike {
  const files = overrides?.files ?? new Map<string, string>();
  const commandResults = overrides?.commandResults ?? new Map();

  return {
    files: {
      write: vi.fn(async (path: string, content: string) => {
        files.set(path, content);
      }),
      read: vi.fn(async (path: string) => files.get(path) ?? ""),
      list: vi.fn(async () => []),
    },
    commands: {
      run: vi.fn(async (cmd: string) => {
        // Check for exact match first, then prefix match
        for (const [pattern, result] of commandResults) {
          if (cmd.includes(pattern)) return result;
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    },
    kill: vi.fn(async () => {}),
  };
}

describe("E2BSandbox.takeScreenshot", () => {
  it("installs puppeteer, writes script, runs it, and returns base64", async () => {
    const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
    const commandResults = new Map([
      ["base64", { stdout: fakeBase64, stderr: "", exitCode: 0 }],
      ["node /tmp/take-screenshot.js", { stdout: "", stderr: "", exitCode: 0 }],
    ]);
    const mockSbx = createMockSandbox({ commandResults });
    const sandbox = new E2BSandbox(async () => mockSbx);

    const id = await sandbox.createSandbox();
    const result = await sandbox.takeScreenshot(id, "http://localhost:3000");

    expect(result.base64Png).toBe(fakeBase64);
    expect(result.url).toBe("http://localhost:3000");
    expect(result.viewport).toEqual({ width: 1280, height: 720 });

    // Verify puppeteer was installed
    expect(mockSbx.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("npm install --no-save puppeteer"),
      expect.any(Object),
    );

    // Verify screenshot script was written
    expect(mockSbx.files.write).toHaveBeenCalledWith(
      "/tmp/take-screenshot.js",
      expect.stringContaining("puppeteer"),
    );
  });

  it("uses custom viewport dimensions", async () => {
    const fakeBase64 = "AAAA";
    const commandResults = new Map([
      ["base64", { stdout: fakeBase64, stderr: "", exitCode: 0 }],
    ]);
    const mockSbx = createMockSandbox({ commandResults });
    const sandbox = new E2BSandbox(async () => mockSbx);

    const id = await sandbox.createSandbox();
    const result = await sandbox.takeScreenshot(id, "http://localhost:5173", {
      width: 800,
      height: 600,
    });

    expect(result.viewport).toEqual({ width: 800, height: 600 });

    // Verify the script contains the custom viewport
    const writeCall = (mockSbx.files.write as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "/tmp/take-screenshot.js",
    );
    expect(writeCall).toBeDefined();
    expect(writeCall![1]).toContain("width: 800");
    expect(writeCall![1]).toContain("height: 600");
  });

  it("throws SandboxError when screenshot script fails", async () => {
    const commandResults = new Map([
      ["node /tmp/take-screenshot.js", { stdout: "", stderr: "Browser failed to launch", exitCode: 1 }],
    ]);
    const mockSbx = createMockSandbox({ commandResults });
    const sandbox = new E2BSandbox(async () => mockSbx);

    const id = await sandbox.createSandbox();
    await expect(sandbox.takeScreenshot(id, "http://localhost:3000")).rejects.toThrow(
      /Screenshot script failed/,
    );
  });

  it("throws SandboxError when base64 read fails", async () => {
    const commandResults = new Map([
      ["node /tmp/take-screenshot.js", { stdout: "", stderr: "", exitCode: 0 }],
      ["base64", { stdout: "", stderr: "No such file", exitCode: 1 }],
    ]);
    const mockSbx = createMockSandbox({ commandResults });
    const sandbox = new E2BSandbox(async () => mockSbx);

    const id = await sandbox.createSandbox();
    await expect(sandbox.takeScreenshot(id, "http://localhost:3000")).rejects.toThrow(
      /Failed to read screenshot/,
    );
  });

  it("throws for unknown sandbox id", async () => {
    const sandbox = new E2BSandbox(async () => createMockSandbox());
    await expect(sandbox.takeScreenshot("sbx_999", "http://localhost:3000")).rejects.toThrow(
      /Unknown sandbox id/,
    );
  });
});

describe("E2BSandbox.createWarmSandbox", () => {
  it("installs template packages and writes marker file", async () => {
    const files = new Map<string, string>();
    const mockSbx = createMockSandbox({ files });
    const sandbox = new E2BSandbox(async () => mockSbx);

    const id = await sandbox.createWarmSandbox("node-express");

    expect(id).toMatch(/^sbx_/);
    // Marker file should be written
    expect(files.get("/tmp/.warm_node-express")).toBe("warm:node-express");
    // npm install should have been called with express, vitest, supertest
    expect(mockSbx.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("npm install express vitest supertest"),
      expect.any(Object),
    );
  });

  it("skips install when marker file already exists", async () => {
    const commandResults = new Map([
      ["test -f /tmp/.warm_node-express", { stdout: "warm", stderr: "", exitCode: 0 }],
    ]);
    const mockSbx = createMockSandbox({ commandResults });
    const sandbox = new E2BSandbox(async () => mockSbx);

    const id = await sandbox.createWarmSandbox("node-express");
    expect(id).toMatch(/^sbx_/);

    // npm install should NOT have been called
    const runCalls = (mockSbx.commands.run as ReturnType<typeof vi.fn>).mock.calls;
    const installCalls = runCalls.filter((c: unknown[]) =>
      (c[0] as string).includes("npm install"),
    );
    expect(installCalls.length).toBe(0);
  });

  it("base template writes marker without installing", async () => {
    const files = new Map<string, string>();
    const mockSbx = createMockSandbox({ files });
    const sandbox = new E2BSandbox(async () => mockSbx);

    await sandbox.createWarmSandbox("base");
    expect(files.get("/tmp/.warm_base")).toBe("warm:base");

    const runCalls = (mockSbx.commands.run as ReturnType<typeof vi.fn>).mock.calls;
    const installCalls = runCalls.filter((c: unknown[]) =>
      (c[0] as string).includes("npm install"),
    );
    expect(installCalls.length).toBe(0);
  });

  it("throws for unknown template name", async () => {
    const sandbox = new E2BSandbox(async () => createMockSandbox());
    await expect(sandbox.createWarmSandbox("nonexistent")).rejects.toThrow(
      /Unknown template/,
    );
  });
});
