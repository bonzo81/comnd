import { describe, expect, it } from "vitest";
import { collectCredential, renderCredentialFieldset, updateCredentialVisibility } from "./credential-fieldset";

function fields(data: Record<string, string>): (key: string) => string | null {
  return (key) => data[key] ?? null;
}

describe("collectCredential", () => {
  it("password → { type: 'password' } + password string", () => {
    const r = collectCredential("auth_type", fields({ auth_type: "password", password: "hunter2" }));
    expect(r.credential).toEqual({ type: "password" });
    expect(r.password).toBe("hunter2");
  });

  it("ssh_key → key_path", () => {
    const r = collectCredential("auth_type", fields({ auth_type: "ssh_key", ssh_key_path: "~/.ssh/id_rsa" }));
    expect(r.credential).toEqual({ type: "ssh_key", key_path: "~/.ssh/id_rsa" });
  });

  it("agent → identity, blank → null identity", () => {
    expect(collectCredential("auth_type", fields({ auth_type: "agent", agent_identity: "aa:bb" })).credential).toEqual({
      type: "agent",
      identity: "aa:bb",
    });
    expect(collectCredential("auth_type", fields({ auth_type: "agent", agent_identity: "" })).credential).toEqual({
      type: "agent",
      identity: null,
    });
  });

  it("secret_ref → provider + reference + label", () => {
    const r = collectCredential("auth_type", fields({ auth_type: "secret_ref", secret_ref_provider: "proton", secret_ref_reference: "item/42" }), "VPN creds");
    expect(r.credential).toEqual({ type: "secret_ref", provider: "proton", reference: "item/42", label: "VPN creds" });
  });

  it("extra radio values (none/inherit) → null", () => {
    expect(collectCredential("netbox_auth_type", fields({ netbox_auth_type: "none" })).credential).toBeNull();
    expect(collectCredential("auth_type", fields({ auth_type: "inherit" })).credential).toBeNull();
  });

  it("missing auth_type → null", () => {
    expect(collectCredential("auth_type", fields({})).credential).toBeNull();
  });
});

describe("renderCredentialFieldset", () => {
  it("renders four radios with the given name and checks the credential type", () => {
    const html = renderCredentialFieldset({
      name: "auth_type",
      credential: { type: "ssh_key", key_path: "/k" },
      providers: [],
      idPrefix: "hs-auth",
    });
    expect(html).toContain('name="auth_type" value="password"');
    expect(html).toContain('name="auth_type" value="ssh_key" checked');
    expect(html).toContain('name="auth_type" value="agent"');
    expect(html).toContain('name="auth_type" value="secret_ref"');
  });

  it("defaults to password when no credential", () => {
    const html = renderCredentialFieldset({ name: "auth_type", credential: null, providers: [], idPrefix: "hs-auth" });
    expect(html).toContain('value="password" checked');
  });

  it("defaultType overrides the fallback checked radio (inherit/none)", () => {
    const html = renderCredentialFieldset({
      name: "auth_type",
      credential: null,
      providers: [],
      idPrefix: "nb-cfg",
      defaultType: "inherit",
      extraRadios: [{ value: "inherit", checked: true, label: "Inherit source default" }],
    });
    expect(html).toContain('value="inherit" checked');
    expect(html).not.toContain('value="password" checked');
  });

  it("renders extra radios first (none/inherit)", () => {
    const html = renderCredentialFieldset({
      name: "netbox_auth_type",
      credential: null,
      providers: [],
      idPrefix: "netbox-auth",
      extraRadios: [{ value: "none", checked: true, label: "None" }],
    });
    const noneIdx = html.indexOf('value="none"');
    const pwIdx = html.indexOf('value="password"');
    expect(noneIdx).toBeGreaterThan(-1);
    expect(noneIdx).toBeLessThan(pwIdx);
  });

  it("prefills key path and reference values", () => {
    const html = renderCredentialFieldset({
      name: "auth_type",
      credential: { type: "secret_ref", provider: "proton", reference: "ref/1", label: null },
      providers: [{ id: "proton", label: "Proton Pass" }],
      idPrefix: "hs-auth",
    });
    expect(html).toContain('value="ref/1"');
    expect(html).toContain('value="proton"');
    expect(html).toContain('Proton Pass');
  });

  it("shows no-providers hint when provider list empty", () => {
    const html = renderCredentialFieldset({
      name: "auth_type",
      credential: null,
      providers: [],
      idPrefix: "hs-auth",
      noProvidersHint: "No secret managers ready",
    });
    expect(html).toContain("No secret managers ready");
  });
});

describe("updateCredentialVisibility", () => {
  function mount(name: string, checked: string): HTMLElement {
    const el = document.createElement("div");
    el.innerHTML = `
      ${["password", "ssh_key", "agent", "secret_ref"]
        .map((v) => `<input type="radio" name="${name}" value="${v}" ${v === checked ? "checked" : ""}>`)
        .join("")}
      <div id="t-password-field" class="auth-conditional"></div>
      <div id="t-key-field" class="auth-conditional"></div>
      <div id="t-agent-field" class="auth-conditional"></div>
      <div id="t-secretref-field" class="auth-conditional"></div>
    `;
    return el;
  }

  it("hides all but the checked type", () => {
    const el = mount("auth_type", "agent");
    updateCredentialVisibility(el, "auth_type", "t");
    expect(el.querySelector("#t-agent-field")!.classList.contains("auth-conditional-hidden")).toBe(false);
    for (const id of ["#t-password-field", "#t-key-field", "#t-secretref-field"]) {
      expect(el.querySelector(id)!.classList.contains("auth-conditional-hidden")).toBe(true);
    }
  });

  it("hides everything for none/inherit", () => {
    const el = mount("netbox_auth_type", "none");
    updateCredentialVisibility(el, "netbox_auth_type", "t");
    for (const id of ["#t-password-field", "#t-key-field", "#t-agent-field", "#t-secretref-field"]) {
      expect(el.querySelector(id)!.classList.contains("auth-conditional-hidden")).toBe(true);
    }
  });
});