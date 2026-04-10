/**
 * Pre-defined stack templates for warm sandbox provisioning.
 * Each template specifies the npm packages to pre-install so that
 * builds skip redundant dependency installation.
 */

/** A sandbox stack template. */
export interface SandboxTemplate {
  /** Unique template key. */
  name: string;
  /** Human-readable label. */
  label: string;
  /** npm packages to pre-install (with optional version specifiers). */
  packages: string[];
  /** Shell script run after npm install (e.g. creating config files). */
  postInstall?: string;
  /** Marker file written to the sandbox after setup completes. */
  markerPath: string;
}

/** All available templates, keyed by name. */
export const TEMPLATES: Record<string, SandboxTemplate> = {
  "node-express": {
    name: "node-express",
    label: "Node.js + Express + vitest + supertest",
    packages: ["express", "vitest", "supertest"],
    markerPath: "/tmp/.warm_node-express",
  },
  react: {
    name: "react",
    label: "Node.js + React + Vite + vitest",
    packages: ["react", "react-dom", "vite", "@vitejs/plugin-react", "vitest"],
    markerPath: "/tmp/.warm_react",
  },
  "node-cli": {
    name: "node-cli",
    label: "Node.js + commander + vitest",
    packages: ["commander", "vitest"],
    markerPath: "/tmp/.warm_node-cli",
  },
  base: {
    name: "base",
    label: "Node.js only",
    packages: [],
    markerPath: "/tmp/.warm_base",
  },
};

/** Keywords that map to each template (checked against spec description + stack). */
const TEMPLATE_MATCHERS: { pattern: RegExp; template: string }[] = [
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
  return new Set(tpl.packages.map((p) => p.replace(/@[^/].*$/, "")));
}
