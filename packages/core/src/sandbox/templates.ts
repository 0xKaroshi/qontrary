/**
 * Pre-defined stack templates for warm sandbox provisioning.
 * Each template specifies packages to pre-install so that
 * builds skip redundant dependency installation.
 */

/** Runtime environment for a sandbox template. */
export type SandboxRuntime = "node" | "python";

/** A sandbox stack template. */
export interface SandboxTemplate {
  /** Unique template key. */
  name: string;
  /** Human-readable label. */
  label: string;
  /** Runtime environment (node or python). */
  runtime: SandboxRuntime;
  /** Packages to pre-install (npm for node, pip for python). */
  packages: string[];
  /** Shell script run after package install (e.g. creating config files). */
  postInstall?: string;
  /** Marker file written to the sandbox after setup completes. */
  markerPath: string;
}

/** All available templates, keyed by name. */
export const TEMPLATES: Record<string, SandboxTemplate> = {
  "node-express": {
    name: "node-express",
    label: "Node.js + Express + vitest + supertest",
    runtime: "node",
    packages: ["express", "vitest", "supertest"],
    markerPath: "/tmp/.warm_node-express",
  },
  react: {
    name: "react",
    label: "Node.js + React + Vite + vitest",
    runtime: "node",
    packages: ["react", "react-dom", "vite", "@vitejs/plugin-react", "vitest"],
    markerPath: "/tmp/.warm_react",
  },
  "node-cli": {
    name: "node-cli",
    label: "Node.js + commander + vitest",
    runtime: "node",
    packages: ["commander", "vitest"],
    markerPath: "/tmp/.warm_node-cli",
  },
  base: {
    name: "base",
    label: "Node.js only",
    runtime: "node",
    packages: [],
    markerPath: "/tmp/.warm_base",
  },
  "python-cli": {
    name: "python-cli",
    label: "Python 3.11 + pytest",
    runtime: "python",
    packages: ["pytest", "pytest-cov"],
    markerPath: "/tmp/.warm_python-cli",
  },
  "python-web": {
    name: "python-web",
    label: "Python 3.11 + Flask + pytest",
    runtime: "python",
    packages: ["flask", "pytest", "pytest-cov"],
    markerPath: "/tmp/.warm_python-web",
  },
  "python-stdlib": {
    name: "python-stdlib",
    label: "Python 3.11 only + pytest",
    runtime: "python",
    packages: ["pytest"],
    markerPath: "/tmp/.warm_python-stdlib",
  },
};

/** Keywords that map to each template (checked against spec description + stack). */
const TEMPLATE_MATCHERS: { pattern: RegExp; template: string }[] = [
  // Python matchers first (more specific)
  { pattern: /\b(flask|django|fastapi|uvicorn|gunicorn)\b/i, template: "python-web" },
  { pattern: /\bstdlib\s+only\b/i, template: "python-stdlib" },
  { pattern: /\bno\s+pip\b/i, template: "python-stdlib" },
  { pattern: /\bpython\b/i, template: "python-cli" },
  // Node matchers
  { pattern: /\b(express|supertest|rest\s*api|api\s*server|middleware)\b/i, template: "node-express" },
  { pattern: /\b(react|vite|jsx|tsx|frontend|component|ui)\b/i, template: "react" },
  { pattern: /\b(cli|command[- ]line|commander|yargs|terminal)\b/i, template: "node-cli" },
];

/**
 * Match a spec to the best sandbox template.
 * @param description spec description
 * @param stack spec stack array
 * @returns matched template name, or "base" if nothing specific matches
 */
export function matchTemplate(description: string, stack: string[]): string {
  const haystack = [description, ...stack].join(" ").toLowerCase();
  for (const { pattern, template } of TEMPLATE_MATCHERS) {
    if (pattern.test(haystack)) return template;
  }
  return "base";
}

/**
 * Get the list of packages a template pre-installs, for filtering plan dependencies.
 * @param templateName template key
 * @returns set of bare package names (no version specifiers)
 */
export function getPreInstalledPackages(templateName: string): Set<string> {
  const tpl = TEMPLATES[templateName];
  if (!tpl) return new Set();
  return new Set(
    tpl.packages.map((p) => {
      // Strip npm version: express@4.18 → express, @scope/pkg@1.0 → @scope/pkg
      // Strip pip version: click>=8.0 → click, pytest-cov~=4.0 → pytest-cov
      return p.replace(/[@>=<~!][^/].*$/, "");
    }),
  );
}

/**
 * Detect whether a spec targets a Python runtime.
 * @param description spec description
 * @param stack spec stack array
 * @returns true if the spec is a Python project
 */
export function isPythonProject(description: string, stack: string[]): boolean {
  const tpl = TEMPLATES[matchTemplate(description, stack)];
  return tpl?.runtime === "python";
}
