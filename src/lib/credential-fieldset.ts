/**
 * CredentialFieldset — shared auth radio group + conditional inputs.
 * One renderer for the host form, NetBox default-auth settings, and the
 * NetBox per-device configure dialog. Markup mirrors the previous
 * per-component copies exactly (same classes, same structure).
 */

import { CredentialSource } from "./tauri-api";
import { escAttr, escHtml } from "./format";
import { icons } from "./icons";

export interface CredentialFieldsetOptions {
  /** Radio name attribute: "auth_type" | "netbox_auth_type". */
  name: string;
  /** Preselect radio; null = the defaultType is checked. */
  credential: CredentialSource | null;
  /** Checked when credential is null. Defaults to "password"; NetBox dialog uses "inherit"/"none". */
  defaultType?: string;
  /** Secret-ref provider <option> values (ready providers + saved). */
  providers: { id: string; label: string }[];
  /** Optional extra radios rendered first, e.g. "none"/"inherit" (value + checked + label). */
  extraRadios?: { value: string; checked: boolean; label: string }[];
  /** Password field extras: badge + placeholder differ per form. */
  passwordBadge?: boolean;
  passwordBadgeLabel?: string;
  passwordPlaceholder?: string;
  /** Suffix for conditional-field ids, e.g. "hs-auth" → #hs-auth-password-field. */
  idPrefix: string;
  /** Hint when no secret managers are ready. */
  noProvidersHint?: string;
  /** Agent identity <option> markup when the form offers a select (host form). */
  agentIdentityOptions?: string;
  /** Agent hint lines rendered under the identity field. */
  agentHints?: string;
  /** Reference-input placeholder (host form uses a combobox hint). */
  referencePlaceholder?: string;
  /** Class for the div wrapping the reference label (host form: combobox positioning). */
  referenceWrapClass?: string;
  /** Extra markup after the reference label (e.g. combobox item list). */
  referenceExtra?: string;
}

const TYPES = ["password", "ssh_key", "agent", "secret_ref"] as const;

export function renderCredentialFieldset(o: CredentialFieldsetOptions): string {
  const sel = o.credential?.type ?? "";
  const checked = (v: string) => (sel === v || (!sel && v === (o.defaultType ?? "password")) ? "checked" : "");
  const condId = (suffix: string) => ` id="${o.idPrefix}-${suffix}"`;
  const hidden = (on: boolean) => (on ? "" : "auth-conditional-hidden");
  const providerOptions =
    o.providers.length === 0
      ? `<option value="" disabled selected>No secret managers ready</option>`
      : o.providers
          .map(
            (p) =>
              `<option value="${escAttr(p.id)}" ${sel === "secret_ref" && o.credential?.type === "secret_ref" && o.credential.provider === p.id ? "selected" : ""}>${escHtml(p.label)}</option>`,
          )
          .join("");

  return `
    <fieldset class="form-auth-group">
      <legend>Authentication</legend>
      ${(o.extraRadios ?? [])
        .map((r) => `<label class="radio-label"><input type="radio" name="${o.name}" value="${escAttr(r.value)}" ${r.checked ? "checked" : ""} /> ${escHtml(r.label)}</label>`)
        .join("")}
      ${TYPES.map(
        (t) =>
          `<label class="radio-label"><input type="radio" name="${o.name}" value="${t}" ${checked(t)} /> ${t === "secret_ref" ? "Secret Manager" : t === "ssh_key" ? "SSH Key" : t === "agent" ? "SSH Agent" : "Password"}</label>`,
      ).join("")}
    </fieldset>
    <div${condId("password-field")} class="auth-conditional ${hidden(sel === "password")}">
      <label>
        <span>Password ${o.passwordBadge ? `<span class="cred-badge">${icons.lock} ${escHtml(o.passwordBadgeLabel ?? "Password saved")}</span>` : ""}</span>
        <input type="password" class="form-input" name="password"
               placeholder="${escAttr(o.passwordPlaceholder ?? "Enter password")}" />
      </label>
    </div>
    <div${condId("key-field")} class="auth-conditional ${hidden(sel === "ssh_key")}">
      <label>
        <span>SSH Key Path</span>
        <input type="text" class="form-input" name="ssh_key_path" placeholder="~/.ssh/id_rsa"
               value="${escAttr(o.credential?.type === "ssh_key" ? o.credential.key_path : "")}" />
      </label>
    </div>
    <div${condId("agent-field")} class="auth-conditional ${hidden(sel === "agent")}">
      <label>
        <span>Identity</span>
        ${o.agentIdentityOptions !== undefined
          ? `<select class="form-input" name="agent_identity">${o.agentIdentityOptions}</select>`
          : `<input type="text" class="form-input" name="agent_identity" placeholder="Blank = offer all identities" spellcheck="false" autocomplete="off" value="${escAttr(o.credential?.type === "agent" ? (o.credential.identity ?? "") : "")}" />`}
      </label>
      ${o.agentHints ?? ""}
    </div>
    <div${condId("secretref-field")} class="auth-conditional auth-conditional-tall ${hidden(sel === "secret_ref")}">
      <label>
        <span>Provider</span>
        <select class="form-input" name="secret_ref_provider">${providerOptions}</select>
      </label>
      ${o.noProvidersHint && o.providers.length === 0 ? `<div class="form-hint">${escHtml(o.noProvidersHint)}</div>` : ""}
      <div${o.referenceWrapClass ? ` class="${escAttr(o.referenceWrapClass)}" id="${o.idPrefix}-ref-combo-wrap"` : ""}>
        <label>
          <span>Reference</span>
          <input type="text" class="form-input" name="secret_ref_reference" placeholder="${escAttr(o.referencePlaceholder ?? "Item reference")}"
                 spellcheck="false" autocomplete="off"
                 value="${escAttr(o.credential?.type === "secret_ref" ? o.credential.reference : "")}" />
        </label>
        ${o.referenceExtra ?? ""}
      </div>
    </div>
  `;
}

/** Toggle conditional fields after a radio change. Root = any container of the fieldset. */
export function updateCredentialVisibility(root: ParentNode, name: string, idPrefix: string): void {
  const selected = root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  const type = selected?.value ?? "";
  const show = (id: string, on: boolean) => {
    root.querySelector<HTMLElement>(id)?.classList.toggle("auth-conditional-hidden", !on);
  };
  show(`#${idPrefix}-password-field`, type === "password");
  show(`#${idPrefix}-key-field`, type === "ssh_key");
  show(`#${idPrefix}-agent-field`, type === "agent");
  show(`#${idPrefix}-secretref-field`, type === "secret_ref");
}

export interface CollectedCredential {
  credential: CredentialSource | null;
  password: string;
}

/**
 * Read the fieldset values via a getter. Forms pass `(k) => fd.get(k)`;
 * container-based sites pass a querySelector getter. Extra radios
 * ("none"/"inherit") map to null — the caller decides whether null is
 * valid for its form.
 */
export function collectCredential(
  name: string,
  get: (key: string) => string | null,
  secretRefLabel: string | null = null,
): CollectedCredential {
  const authType = get(name) || "";
  const password = get("password") ?? "";
  const keyPath = (get("ssh_key_path") ?? "").trim();
  const agentIdentity = (get("agent_identity") ?? "").trim();
  const refProvider = (get("secret_ref_provider") ?? "").trim();
  const refReference = (get("secret_ref_reference") ?? "").trim();

  const credential: CredentialSource | null =
    authType === "password"
      ? { type: "password" }
      : authType === "ssh_key"
        ? { type: "ssh_key", key_path: keyPath }
        : authType === "agent"
          ? { type: "agent", identity: agentIdentity || null }
          : authType === "secret_ref"
            ? { type: "secret_ref", provider: refProvider, reference: refReference, label: secretRefLabel }
            : null;

  return { credential, password };
}