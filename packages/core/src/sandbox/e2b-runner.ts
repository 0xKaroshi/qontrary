import { Sandbox } from "@e2b/code-interpreter";

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
      throw err instanceof SandboxError ? err : new SandboxError(`runCommand failed: ${String(err)}`);
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
