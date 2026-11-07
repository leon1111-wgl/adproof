/* The committed recordings and the browser engine must come from the same rule library: a sample
 * review (replayed) and a visitor's review (computed in the tab) then cite the same version. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pack } from "../src/engine/pack";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf-8"));

describe("recordings match the pack", () => {
  it("index.json and the specimen were recorded with pack.json's rule library", () => {
    expect(read("../public/demo/index.json").ruleset).toMatchObject({ version: pack.ruleset.version, hash: pack.ruleset.hash });
    expect(read("../src/specimen.json").ruleset).toMatchObject({ version: pack.ruleset.version, hash: pack.ruleset.hash });
  });
});
