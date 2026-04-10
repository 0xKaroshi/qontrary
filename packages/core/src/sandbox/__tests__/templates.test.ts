import { describe, it, expect } from "vitest";
import { matchTemplate, getPreInstalledPackages, TEMPLATES } from "../templates.js";

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
});
