import { describe, expect, it } from "vitest";
import { renderReplayTemplate, substitute } from "./replay";
import type { ReplayVariable } from "./tauri-api";

const vars = (...names: string[]): ReplayVariable[] => names.map((name) => ({ name }));

describe("substitute", () => {
  it("replaces every occurrence of a variable", () => {
    const out = substitute(
      "interface {{intf}} ; description {{intf}} ; no shut",
      vars("intf"),
      { intf: "Gi0/1" },
    );
    expect(out).toBe("interface Gi0/1 ; description Gi0/1 ; no shut");
  });

  it("substitutes multiple distinct variables in one template", () => {
    const out = substitute("vlan {{vlan}} name {{name}}", vars("vlan", "name"), {
      vlan: "10",
      name: "USERS",
    });
    expect(out).toBe("vlan 10 name USERS");
  });

  it("throws instead of sending a partially substituted command", () => {
    expect(() => substitute("interface {{intf}}", vars("intf"), {})).toThrow(
      "Missing value for variable 'intf'",
    );
  });

  it("treats a whitespace-only value as missing", () => {
    expect(() => substitute("interface {{intf}}", vars("intf"), { intf: "   " })).toThrow(
      "Missing value for variable 'intf'",
    );
  });

  it("leaves a template without variables unchanged", () => {
    expect(substitute("show version", [], {})).toBe("show version");
  });
});

describe("renderReplayTemplate", () => {
  it("renders each variable as a chip", () => {
    expect(renderReplayTemplate("interface {{intf}}")).toBe(
      'interface <span class="replay-var">intf</span>',
    );
  });

  it("escapes template text before it reaches innerHTML", () => {
    const out = renderReplayTemplate("<b>x</b> {{v}}");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;b&gt;");
  });

  it("escapes a variable name so the only markup is the chip span", () => {
    const out = renderReplayTemplate("{{<script>alert(1)</script>}}");
    expect(out.match(/<[^>]*>/g)).toEqual(['<span class="replay-var">', "</span>"]);
  });

  it("leaves unmatched braces alone", () => {
    expect(renderReplayTemplate("echo {x} {{unclosed")).toBe("echo {x} {{unclosed");
  });
});
