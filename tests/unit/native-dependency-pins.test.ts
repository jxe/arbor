import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("native dependency pins", () => {
  test("Quagmire uses one exact release in both manifests and the standalone lock", () => {
    const project = parse(readFileSync(`${root}/native/project.yml`, "utf8"));
    const packageSource = readFileSync(
      `${root}/native/Packages/ArborQuagmire/Package.swift`,
      "utf8",
    );
    const packageVersion = packageSource.match(
      /\.package\(url: "https:\/\/github\.com\/jxe\/quagmire\.git", exact: "([^"]+)"\)/,
    )?.[1];
    const lock = JSON.parse(
      readFileSync(`${root}/native/Packages/ArborQuagmire/Package.resolved`, "utf8"),
    );
    const lockedVersion = lock.pins.find(
      (pin: { identity: string }) => pin.identity === "quagmire",
    )?.state.version;

    expect(packageVersion).toBeDefined();
    expect(project.packages.Quagmire.exactVersion).toBe(packageVersion);
    expect(lockedVersion).toBe(packageVersion);
  });
});
