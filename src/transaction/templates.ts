/**
 * Transaction template system for reusable common patterns.
 *
 * Save a template once, then load it later with optional parameter
 * substitution via `{{paramName}}` placeholders in string values.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

/** Supported transaction pattern kinds a template can represent. */
export type TransactionTemplateKind =
  | "payment"
  | "createAccount"
  | "trustline"
  | "paymentWithTrustline"
  | "pathPayment"
  | "swap"
  | "atomicSwap"
  | "accountMerge"
  | "custom";

/** Scalar values accepted when applying parameters to a template. */
export type TemplateParamValue = string | number | boolean | null;

/**
 * A reusable transaction template.
 *
 * String fields inside `params` may contain `{{paramName}}` placeholders
 * that are substituted when the template is loaded with parameters.
 */
export interface TransactionTemplate {
  /** Identifies which transaction pattern this template represents. */
  kind: TransactionTemplateKind;
  /** Optional human-readable description. */
  description?: string;
  /**
   * Parameter bag for the template. Nested objects/arrays are supported.
   * String values may include `{{paramName}}` placeholders.
   */
  params: Record<string, unknown>;
}

/**
 * Pluggable store for transaction templates.
 * Use {@link InMemoryTransactionTemplateStore} by default, or supply a
 * persistent implementation (e.g. backed by localStorage / a database).
 */
export interface TransactionTemplateStore {
  save(name: string, template: TransactionTemplate): void;
  get(name: string): TransactionTemplate | undefined;
  has(name: string): boolean;
  list(): string[];
  delete(name: string): boolean;
  clear(): void;
}

/** In-memory Map-based template store. Suitable for Node scripts and tests. */
export class InMemoryTransactionTemplateStore
  implements TransactionTemplateStore
{
  private readonly templates = new Map<string, TransactionTemplate>();

  save(name: string, template: TransactionTemplate): void {
    this.templates.set(name, structuredClone(template));
  }

  get(name: string): TransactionTemplate | undefined {
    const stored = this.templates.get(name);
    return stored === undefined ? undefined : structuredClone(stored);
  }

  has(name: string): boolean {
    return this.templates.has(name);
  }

  list(): string[] {
    return Array.from(this.templates.keys()).sort();
  }

  delete(name: string): boolean {
    return this.templates.delete(name);
  }

  clear(): void {
    this.templates.clear();
  }
}

/** Default module-level in-memory store used when no store is provided. */
const defaultTemplateStore = new InMemoryTransactionTemplateStore();

const PLACEHOLDER_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const VALID_KINDS = new Set<TransactionTemplateKind>([
  "payment",
  "createAccount",
  "trustline",
  "paymentWithTrustline",
  "pathPayment",
  "swap",
  "atomicSwap",
  "accountMerge",
  "custom",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateName(name: string): SorokitResult<void> {
  if (typeof name !== "string" || name.trim().length === 0) {
    return err(
      SorokitErrorCode.UNKNOWN,
      "Template name must be a non-empty string.",
    );
  }
  return ok(undefined);
}

function validateTemplate(
  template: TransactionTemplate,
): SorokitResult<void> {
  if (!isPlainObject(template)) {
    return err(
      SorokitErrorCode.UNKNOWN,
      "Template must be a non-null object.",
    );
  }

  if (!VALID_KINDS.has(template.kind)) {
    return err(
      SorokitErrorCode.UNKNOWN,
      `Unsupported template kind: ${String(template.kind)}.`,
    );
  }

  if (!isPlainObject(template.params)) {
    return err(
      SorokitErrorCode.UNKNOWN,
      "Template params must be a plain object.",
    );
  }

  if (
    template.description !== undefined &&
    typeof template.description !== "string"
  ) {
    return err(
      SorokitErrorCode.UNKNOWN,
      "Template description must be a string when provided.",
    );
  }

  return ok(undefined);
}

/**
 * Substitute `{{paramName}}` placeholders in a string using the provided params.
 * Returns an error if any placeholder remains unresolved.
 */
function substituteString(
  value: string,
  params: Record<string, TemplateParamValue>,
): SorokitResult<string> {
  const unresolved = new Set<string>();

  const replaced = value.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      unresolved.add(key);
      return _match;
    }
    const paramValue = params[key];
    if (paramValue === null || paramValue === undefined) {
      return "";
    }
    return String(paramValue);
  });

  if (unresolved.size > 0) {
    const missing = Array.from(unresolved).sort().join(", ");
    return err(
      SorokitErrorCode.UNKNOWN,
      `Missing template parameters: ${missing}.`,
    );
  }

  return ok(replaced);
}

/**
 * Deeply apply parameter substitution to a value tree.
 * Only string leaves are substituted; other scalars are left as-is.
 */
function applyParams(
  value: unknown,
  params: Record<string, TemplateParamValue>,
): SorokitResult<unknown> {
  if (typeof value === "string") {
    const substituted = substituteString(value, params);
    if (substituted.status === "error") {
      return err(
        substituted.error.code,
        substituted.error.message,
        substituted.error.cause,
      );
    }
    return ok(substituted.data);
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const applied = applyParams(item, params);
      if (applied.status === "error") return applied;
      result.push(applied.data);
    }
    return ok(result);
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const applied = applyParams(child, params);
      if (applied.status === "error") return applied;
      result[key] = applied.data;
    }
    return ok(result);
  }

  return ok(value);
}

/**
 * Save a transaction template under the given name.
 *
 * Templates are stored in the default in-memory store unless a custom
 * {@link TransactionTemplateStore} is provided (for persistence).
 *
 * @param name - Unique template name.
 * @param template - Template definition including kind and params.
 * @param store - Optional store override (defaults to module in-memory store).
 * @returns The saved template on success.
 *
 * @example
 * const saved = saveTransactionTemplate("xlm-payment", {
 *   kind: "payment",
 *   description: "Send XLM to a destination",
 *   params: { destination: "{{destination}}", amount: "{{amount}}" },
 * });
 */
export function saveTransactionTemplate(
  name: string,
  template: TransactionTemplate,
  store: TransactionTemplateStore = defaultTemplateStore,
): SorokitResult<TransactionTemplate> {
  const nameResult = validateName(name);
  if (nameResult.status === "error") {
    return err(nameResult.error.code, nameResult.error.message, nameResult.error.cause);
  }

  const templateResult = validateTemplate(template);
  if (templateResult.status === "error") {
    return err(
      templateResult.error.code,
      templateResult.error.message,
      templateResult.error.cause,
    );
  }

  const toStore: TransactionTemplate = {
    kind: template.kind,
    params: structuredClone(template.params),
  };
  if (template.description !== undefined) {
    toStore.description = template.description;
  }

  store.save(name.trim(), toStore);
  return ok(structuredClone(toStore));
}

/**
 * Load a saved transaction template, optionally applying parameter substitution.
 *
 * When `params` is provided, every `{{paramName}}` placeholder in string
 * values (including nested objects/arrays) is replaced. Missing parameters
 * produce an error result.
 *
 * @param name - Template name to load.
 * @param params - Optional parameter map for placeholder substitution.
 * @param store - Optional store override (defaults to module in-memory store).
 * @returns The loaded (and optionally parameterized) template.
 *
 * @example
 * const loaded = loadTemplate("xlm-payment", {
 *   destination: "GDEST...",
 *   amount: "10",
 * });
 * if (loaded.status === "ok") {
 *   // loaded.data.params.destination === "GDEST..."
 *   // loaded.data.params.amount === "10"
 * }
 */
export function loadTemplate(
  name: string,
  params?: Record<string, TemplateParamValue>,
  store: TransactionTemplateStore = defaultTemplateStore,
): SorokitResult<TransactionTemplate> {
  const nameResult = validateName(name);
  if (nameResult.status === "error") {
    return err(nameResult.error.code, nameResult.error.message, nameResult.error.cause);
  }

  const stored = store.get(name.trim());
  if (stored === undefined) {
    return err(
      SorokitErrorCode.TX_NOT_FOUND,
      `Transaction template "${name.trim()}" was not found.`,
    );
  }

  if (params === undefined) {
    return ok(stored);
  }

  const appliedParams = applyParams(stored.params, params);
  if (appliedParams.status === "error") {
    return err(
      appliedParams.error.code,
      appliedParams.error.message,
      appliedParams.error.cause,
    );
  }

  const result: TransactionTemplate = {
    kind: stored.kind,
    params: appliedParams.data as Record<string, unknown>,
  };
  if (stored.description !== undefined) {
    result.description = stored.description;
  }
  return ok(result);
}

/**
 * List all saved template names in the store.
 */
export function listTransactionTemplates(
  store: TransactionTemplateStore = defaultTemplateStore,
): SorokitResult<string[]> {
  return ok(store.list());
}

/**
 * Delete a saved template by name.
 * @returns `true` if a template was removed, `false` if it did not exist.
 */
export function deleteTransactionTemplate(
  name: string,
  store: TransactionTemplateStore = defaultTemplateStore,
): SorokitResult<boolean> {
  const nameResult = validateName(name);
  if (nameResult.status === "error") {
    return err(nameResult.error.code, nameResult.error.message, nameResult.error.cause);
  }
  return ok(store.delete(name.trim()));
}

/**
 * Clear all templates from the store.
 * Useful for test isolation when using the default in-memory store.
 */
export function clearTransactionTemplates(
  store: TransactionTemplateStore = defaultTemplateStore,
): SorokitResult<void> {
  store.clear();
  return ok(undefined);
}
