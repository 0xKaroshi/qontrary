import { describe, it, expect } from "vitest";
import { matchTemplate, getPreInstalledPackages, isPythonProject, TEMPLATES } from "../templates.js";

describe("matchTemplate", () => {
  it("matches Express spec to node-express template", () => {
    expect(matchTemplate("Build an Express API with health endpoint", ["node", "express"])).toBe(
      "node-express",
    );
  });

  it("matches REST API spec to node-express template", () => {
    expect(matchTemplate("Build a REST API for todos", ["node"])).toBe("node-express");
  });

  it("matches React spec to react template", () => {
    expect(matchTemplate("Create a React component for a table", ["react", "typescript"])).toBe(
      "react",
    );
  });

  it("matches Vite spec to react template", () => {
    expect(matchTemplate("Build a frontend dashboard with Vite", ["node"])).toBe("react");
  });

  it("matches CLI spec to node-cli template", () => {
    expect(matchTemplate("Build a command-line tool for file conversion", ["node"])).toBe(
      "node-cli",
    );
  });

  it("falls back to base for unrecognized stacks", () => {
    expect(matchTemplate("Sort an array of numbers", ["node"])).toBe("base");
  });

  it("matches from stack array as well as description", () => {
    expect(matchTemplate("Simple server", ["express", "node"])).toBe("node-express");
  });

  it("matches Python CLI spec to python-cli template", () => {
    expect(matchTemplate("Build a security audit tool", ["Python 3.11", "click"])).toBe(
      "python-cli",
    );
  });

  it("matches Flask spec to python-web template", () => {
    expect(matchTemplate("Build a Flask REST API", ["python", "flask"])).toBe("python-web");
  });

  it("matches Django spec to python-web template", () => {
    expect(matchTemplate("Create a Django web app", ["django"])).toBe("python-web");
  });

  it("matches FastAPI spec to python-web template", () => {
    expect(matchTemplate("Build an API with FastAPI", ["python", "fastapi"])).toBe("python-web");
  });

  it("matches stdlib-only spec to python-stdlib template", () => {
    expect(matchTemplate("Build a tool using stdlib only, no pip dependencies", ["Python 3.11"])).toBe(
      "python-stdlib",
    );
  });

  it("matches 'no pip' spec to python-stdlib template", () => {
    expect(matchTemplate("Read-only scan, no pip dependencies", ["Python 3.11"])).toBe(
      "python-stdlib",
    );
  });
});

describe("getPreInstalledPackages", () => {
  it("returns express packages for node-express", () => {
    const pkgs = getPreInstalledPackages("node-express");
    expect(pkgs.has("express")).toBe(true);
    expect(pkgs.has("vitest")).toBe(true);
    expect(pkgs.has("supertest")).toBe(true);
  });

  it("returns react packages for react template", () => {
    const pkgs = getPreInstalledPackages("react");
    expect(pkgs.has("react")).toBe(true);
    expect(pkgs.has("vite")).toBe(true);
    expect(pkgs.has("vitest")).toBe(true);
  });

  it("returns empty set for base template", () => {
    expect(getPreInstalledPackages("base").size).toBe(0);
  });

  it("returns empty set for unknown template", () => {
    expect(getPreInstalledPackages("nonexistent").size).toBe(0);
  });

  it("returns pytest for python-cli template", () => {
    const pkgs = getPreInstalledPackages("python-cli");
    expect(pkgs.has("pytest")).toBe(true);
    expect(pkgs.has("pytest-cov")).toBe(true);
  });

  it("returns flask + pytest for python-web template", () => {
    const pkgs = getPreInstalledPackages("python-web");
    expect(pkgs.has("flask")).toBe(true);
    expect(pkgs.has("pytest")).toBe(true);
  });
});

describe("isPythonProject", () => {
  it("returns true for Python specs", () => {
    expect(isPythonProject("Build a security audit tool", ["Python 3.11", "click"])).toBe(true);
  });

  it("returns true for Flask specs", () => {
    expect(isPythonProject("Build an API", ["flask", "python"])).toBe(true);
  });

  it("returns false for Node.js specs", () => {
    expect(isPythonProject("Build an Express API", ["node", "express"])).toBe(false);
  });

  it("returns false for base specs", () => {
    expect(isPythonProject("Sort numbers", ["node"])).toBe(false);
  });
});

describe("TEMPLATES", () => {
  it("all templates have unique marker paths", () => {
    const markers = Object.values(TEMPLATES).map((t) => t.markerPath);
    expect(new Set(markers).size).toBe(markers.length);
  });

  it("all templates have a name matching their key", () => {
    for (const [key, tpl] of Object.entries(TEMPLATES)) {
      expect(tpl.name).toBe(key);
    }
  });

  it("all templates have a valid runtime", () => {
    for (const tpl of Object.values(TEMPLATES)) {
      expect(["node", "python"]).toContain(tpl.runtime);
    }
  });

  it("Python templates use python runtime", () => {
    expect(TEMPLATES["python-cli"]!.runtime).toBe("python");
    expect(TEMPLATES["python-web"]!.runtime).toBe("python");
    expect(TEMPLATES["python-stdlib"]!.runtime).toBe("python");
  });

  it("Node templates use node runtime", () => {
    expect(TEMPLATES["node-express"]!.runtime).toBe("node");
    expect(TEMPLATES["react"]!.runtime).toBe("node");
    expect(TEMPLATES["node-cli"]!.runtime).toBe("node");
    expect(TEMPLATES["base"]!.runtime).toBe("node");
  });
});
