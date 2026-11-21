import { describe, expect, it } from "vitest";
import { isNetboxHost, isNetboxHostId } from "./netbox-host";

describe("NetBox host identity", () => {
  it("recognises a NetBox-sourced host by source and by host id", () => {
    expect(isNetboxHost({ id: "netbox:201", source: "netbox" })).toBe(true);
    // A read-time host can carry the source; the id alone is the older form.
    expect(isNetboxHost({ id: "netbox:201", source: null })).toBe(true);
  });

  it("does not recognise a user host", () => {
    expect(isNetboxHost({ id: "0d5f7c2a-3b6e-4f10-9a8c-2b4c6d8e0f12", source: null })).toBe(false);
    expect(isNetboxHost({ id: "0d5f7c2a-3b6e-4f10-9a8c-2b4c6d8e0f12" })).toBe(false);
    expect(isNetboxHost(null)).toBe(false);
    expect(isNetboxHost(undefined)).toBe(false);
  });

  it("requires a numeric suffix and rejects lookalikes", () => {
    expect(isNetboxHostId("netbox:1")).toBe(true);
    expect(isNetboxHostId("netbox:")).toBe(false);
    expect(isNetboxHostId("netbox:12a")).toBe(false);
    expect(isNetboxHostId("netboxx:12")).toBe(false);
    expect(isNetboxHostId("__netbox__:site:dc1")).toBe(false);
  });
});
