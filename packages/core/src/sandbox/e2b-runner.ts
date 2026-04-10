import { Sandbox } from "@e2b/code-interpreter";
import { TEMPLATES, type SandboxTemplate } from "./templates.js";

/** Result from running a shell command in a sandbox. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** A directory entry returned by listFiles. */
export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

/** Result from taking a screenshot in a sandbox. */
export interface ScreenshotResult {
  /** Base64-encoded PNG data. */
  base64Png: string;
  /** URL that was screenshotted. */
  url: string;
  /** Viewport dimensions used. */
  viewport: { width: number; height: number };
}

/**
 * Minimal interface that the wrapper actually depends on.
 * The real E2B `Sandbox` satisfies this; tests can inject a fake.
 */
export interface E2BSandboxLike {
  files: {
    write: (path: string, content: string) => Promise<unknown>;
    read: (path: string) => Promise<string>;
    list: (path: string) => Promise<{ name: string; path: string; type: "file" | "dir" }[]>;
  };
  commands: {
    run: (
      cmd: string,
      opts?: { timeoutMs?: number },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  kill: () => Promise<unknown>;
}

/** Factory used by E2BSandbox to create a real or fake sandbox. */
export type SandboxFactory = () => Promise<E2BSandboxLike>;

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

const COMMAND_TIMEOUT_MS = 60_000;
const SANDBOX_TIMEOUT_MS = 30 * 60_000;

interface SandboxRecord {
  sandbox: E2BSandboxLike;
  createdAt: number;
}

/**
 * Wrapper around E2B sandboxes with timeout + usage tracking.
 */
export class E2BSandbox {
  private sandboxes = new Map<string, SandboxRecord>();
  private nextId = 1;
  private factory: SandboxFactory;

  /**
   * @param factory optional factory; defaults to the real @e2b/code-interpreter Sandbox
   */
  constructor(factory?: SandboxFactory) {
    this.factory =
      factory ??
      (async () => (await Sandbox.create()) as unknown as E2BSandboxLike);
  }

  /**
   * Spin up a new sandbox and return its id.
   */
  async createSandbox(): Promise<string> {
    try {
      const sandbox = await this.factory();
      const id = `sbx_${this.nextId++}`;
      this.sandboxes.set(id, { sandbox, createdAt: Date.now() });
      return id;
    } catch (err) {
      throw err instanceof SandboxError ? err : new SandboxError(`createSandbox failed: ${String(err)}`);
    }
  }

  /**
   * Create a sandbox pre-provisioned with a stack template.
   * If the template's marker file already exists (e.g. re-used sandbox), the
   * install step is skipped.
   * @param templateName key from TEMPLATES (e.g. "node-express", "react")
   * @returns sandbox id
   */
  async createWarmSandbox(templateName: string): Promise<string> {
    const tpl: SandboxTemplate | undefined = TEMPLATES[templateName];
    if (!tpl) {
      throw new SandboxError(`Unknown template: ${templateName}`);
    }
    const id = await this.createSandbox();
    if (tpl.packages.length === 0) {
      // Base template — nothing to install, just write marker
      await this.writeFile(id, tpl.markerPath, `warm:${templateName}`);
      return id;
    }
    try {
      // Check if already provisioned (use this.runCommand to handle CommandExitError)
      const check = await this.runCommand(id, `test -f ${tpl.markerPath} && echo warm`);
      if (check.stdout.trim() === "warm") {
        console.log(`[e2b] sandbox ${id} already warm for ${templateName}`);
        return id;
      }

      // Install template packages
      const installCmd = `npm install ${tpl.packages.join(" ")} 2>&1`;
      console.log(`[e2b] warming sandbox ${id} with template ${templateName}`);
      const installRes = await this.runCommand(id, installCmd);
      if (installRes.exitCode !== 0) {
        console.log(`[e2b] warm install warning (non-fatal): exit ${installRes.exitCode}`);
      }

      // Run post-install if defined
      if (tpl.postInstall) {
        await this.runCommand(id, tpl.postInstall);
      }

      // Write marker
      await this.writeFile(id, tpl.markerPath, `warm:${templateName}`);
      console.log(`[e2b] sandbox ${id} warmed for ${templateName}`);
    } catch (err) {
      // Non-fatal — sandbox still usable, just not warm
      console.log(`[e2b] warm setup failed (non-fatal): ${String(err).slice(0, 120)}`);
    }
    return id;
  }

  /**
   * Resolve a sandbox by id, enforcing the total lifetime budget.
   * @param id sandbox id
   */
  private getRecord(id: string): SandboxRecord {
    const rec = this.sandboxes.get(id);
    if (!rec) throw new SandboxError(`Unknown sandbox id: ${id}`);
    if (Date.now() - rec.createdAt > SANDBOX_TIMEOUT_MS) {
      throw new SandboxError(`Sandbox ${id} exceeded ${SANDBOX_TIMEOUT_MS}ms lifetime`);
    }
    return rec;
  }

  /**
   * Write a file inside the sandbox.
   * @param id sandbox id
   * @param path absolute or relative path inside the sandbox
   * @param content file contents
   */
  async writeFile(id: string, path: string, content: string): Promise<void> {
    try {
      const { sandbox } = this.getRecord(id);
      await sandbox.files.write(path, content);
    } catch (err) {
      throw err instanceof SandboxError ? err : new SandboxError(`writeFile failed: ${String(err)}`);
    }
  }

  /**
   * Read a file from the sandbox.
   * @param id sandbox id
   * @param path file path
   */
  async readFile(id: string, path: string): Promise<string> {
    try {
      const { sandbox } = this.getRecord(id);
      return await sandbox.files.read(path);
    } catch (err) {
      throw err instanceof SandboxError ? err : new SandboxError(`readFile failed: ${String(err)}`);
    }
  }

  /**
   * List a directory in the sandbox.
   * @param id sandbox id
   * @param dir directory path
   */
  async listFiles(id: string, dir: string): Promise<DirEntry[]> {
    try {
      const { sandbox } = this.getRecord(id);
      return await sandbox.files.list(dir);
    } catch (err) {
      throw err instanceof SandboxError ? err : new SandboxError(`listFiles failed: ${String(err)}`);
    }
  }

  /**
   * Run a shell command in the sandbox with a 60s per-command timeout.
   * @param id sandbox id
   * @param command command line to execute
   */
  async runCommand(id: string, command: string): Promise<CommandResult> {
    try {
      const { sandbox } = this.getRecord(id);
      const res = await sandbox.commands.run(command, { timeoutMs: COMMAND_TIMEOUT_MS });
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
    } catch (err) {
      const msg = String(err);
      const exitMatch = msg.match(/exit status (\d+)/);
      if (exitMatch) {
        return { stdout: "", stderr: msg, exitCode: Number(exitMatch[1]) };
      }
      throw err instanceof SandboxError ? err : new SandboxError(`runCommand failed: ${msg}`);
    }
  }

  /**
   * Take a screenshot of a URL running inside the sandbox.
   * Installs puppeteer if needed, navigates to the URL, and returns base64 PNG.
   * @param id sandbox id
   * @param url URL to screenshot (typically http://localhost:PORT)
   * @param viewport optional viewport size (default 1280x720)
   */
  async takeScreenshot(
    id: string,
    url: string,
    viewport: { width: number; height: number } = { width: 1280, height: 720 },
  ): Promise<ScreenshotResult> {
    try {
      const { sandbox } = this.getRecord(id);

      // Install puppeteer (bundles Chromium)
      await sandbox.commands.run("npm install --no-save puppeteer 2>&1 || true", {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });

      // Write a small screenshot script
      const screenshotScript = `
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: ${viewport.width}, height: ${viewport.height} });
  await page.goto('${url}', { waitUntil: 'networkidle0', timeout: 15000 });
  await page.screenshot({ path: '/tmp/screenshot.png', fullPage: false });
  await browser.close();
  process.exit(0);
})().catch(err => { console.error(err.message); process.exit(1); });
`;
      await sandbox.files.write("/tmp/take-screenshot.js", screenshotScript);

      const result = await sandbox.commands.run("node /tmp/take-screenshot.js", {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });

      if (result.exitCode !== 0) {
        throw new SandboxError(`Screenshot script failed (exit ${result.exitCode}): ${result.stderr}`);
      }

      // Read the screenshot as base64
      const pngContent = await sandbox.commands.run(
        "base64 -w 0 /tmp/screenshot.png 2>/dev/null || base64 /tmp/screenshot.png",
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );

      if (!pngContent.stdout || pngContent.exitCode !== 0) {
        throw new SandboxError("Failed to read screenshot file as base64");
      }

      return {
        base64Png: pngContent.stdout.trim(),
        url,
        viewport,
      };
    } catch (err) {
      throw err instanceof SandboxError
        ? err
        : new SandboxError(`takeScreenshot failed: ${String(err)}`);
    }
  }

  /**
   * Destroy a sandbox and log its lifetime usage.
   * @param id sandbox id
   */
  async destroySandbox(id: string): Promise<{ usageMs: number }> {
    const rec = this.sandboxes.get(id);
    if (!rec) throw new SandboxError(`Unknown sandbox id: ${id}`);
    const usageMs = Date.now() - rec.createdAt;
    try {
      await rec.sandbox.kill();
    } catch (err) {
      throw new SandboxError(`destroySandbox failed: ${String(err)}`);
    } finally {
      this.sandboxes.delete(id);
    }
    // Cost tracking — log lifetime usage.
    console.log(`[e2b] sandbox ${id} usage_ms=${usageMs}`);
    return { usageMs };
  }
}
