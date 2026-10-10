import { describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "./ansi";

describe("ansi", () => {
  it("parses colours and resets", () => {
    const segs = parseAnsi("\u001b[31merror\u001b[0m ok");
    expect(segs).toHaveLength(2);
    expect(segs[0]!.text).toBe("error");
    expect(segs[0]!.style.fg).toBeDefined();
    expect(segs[1]!.style.fg).toBeUndefined();
  });
  it("strips", () => {
    expect(stripAnsi("\u001b[1;32mhi\u001b[0m\r")).toBe("hi");
  });
});
