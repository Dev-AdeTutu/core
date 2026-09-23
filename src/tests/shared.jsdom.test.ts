// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { isBrowser } from "../shared/utils";

describe("isBrowser in simulated browser environment", () => {
  it("returns true when window is defined", () => {
    expect(isBrowser()).toBe(true);
  });
});
