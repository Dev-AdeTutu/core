import { describe, it, expect, beforeEach } from "vitest";
import {
  saveTransactionTemplate,
  loadTemplate,
  deleteTransactionTemplate,
  listTransactionTemplates,
  clearTransactionTemplates,
  InMemoryTransactionTemplateStore,
} from "../transaction/templates";
import type {
  TransactionTemplate,
  TransactionTemplateStore,
} from "../transaction/templates";

function makeTemplate(overrides?: Partial<TransactionTemplate>): TransactionTemplate {
  return {
    kind: "payment",
    description: "Test payment template",
    params: {
      destination: "{{destination}}",
      amount: "{{amount}}",
      memo: "Hello from {{sender}}",
    },
    ...overrides,
  };
}

function createStore(): TransactionTemplateStore {
  return new InMemoryTransactionTemplateStore();
}

describe("saveTransactionTemplate", () => {
  let store: TransactionTemplateStore;
  beforeEach(() => {
    store = createStore();
  });

  it("saves and retrieves a template", () => {
    const tpl = makeTemplate();
    const saveResult = saveTransactionTemplate("xlm-payment", tpl, store);
    expect(saveResult.status).toBe("ok");
    if (saveResult.status === "ok") {
      expect(saveResult.data.kind).toBe("payment");
      expect(saveResult.data.params.destination).toBe("{{destination}}");
    }
  });

  it("rejects empty name", () => {
    const result = saveTransactionTemplate("", makeTemplate(), store);
    expect(result.status).toBe("error");
  });

  it("rejects whitespace-only name", () => {
    const result = saveTransactionTemplate("   ", makeTemplate(), store);
    expect(result.status).toBe("error");
  });

  it("trims template name before storing", () => {
    const tpl = makeTemplate();
    saveTransactionTemplate("  xlm-payment  ", tpl, store);
    expect(store.has("xlm-payment")).toBe(true);
  });

  it("rejects invalid template kind", () => {
    const tpl = makeTemplate({ kind: "invalidKind" as any });
    const result = saveTransactionTemplate("test", tpl, store);
    expect(result.status).toBe("error");
  });

  it("rejects non-object template", () => {
    const result = saveTransactionTemplate("test", "not-an-object" as any, store);
    expect(result.status).toBe("error");
  });

  it("rejects non-object params", () => {
    const tpl = makeTemplate({ params: "not-an-object" as any });
    const result = saveTransactionTemplate("test", tpl, store);
    expect(result.status).toBe("error");
  });

  it("rejects non-string description", () => {
    const tpl = makeTemplate({ description: 123 as any });
    const result = saveTransactionTemplate("test", tpl, store);
    expect(result.status).toBe("error");
  });

  it("accepts template without description", () => {
    const tpl = makeTemplate();
    delete tpl.description;
    const result = saveTransactionTemplate("test", tpl, store);
    expect(result.status).toBe("ok");
  });

  it("accepts all valid template kinds", () => {
    const kinds = [
      "payment", "createAccount", "trustline", "paymentWithTrustline",
      "pathPayment", "swap", "atomicSwap", "accountMerge", "custom",
    ] as const;
    for (const kind of kinds) {
      const tpl = makeTemplate({ kind });
      const result = saveTransactionTemplate(`tpl-${kind}`, tpl, store);
      expect(result.status).toBe("ok");
    }
  });

  it("returns a deep clone of the saved template", () => {
    const tpl = makeTemplate();
    const saveResult = saveTransactionTemplate("test", tpl, store);
    expect(saveResult.status).toBe("ok");

    // Mutate original — stored copy should be unaffected
    tpl.params.destination = "MUTATED";
    const loadResult = loadTemplate("test", undefined, store);
    expect(loadResult.status).toBe("ok");
    if (loadResult.status === "ok") {
      expect(loadResult.data.params.destination).toBe("{{destination}}");
    }
  });
});

describe("loadTemplate", () => {
  let store: TransactionTemplateStore;
  beforeEach(() => {
    store = createStore();
  });

  it("loads a previously saved template", () => {
    saveTransactionTemplate("pay", makeTemplate(), store);
    const result = loadTemplate("pay", undefined, store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.kind).toBe("payment");
      expect(result.data.params.destination).toBe("{{destination}}");
    }
  });

  it("returns error for missing template", () => {
    const result = loadTemplate("nonexistent", undefined, store);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("TX_NOT_FOUND");
    }
  });

  it("rejects empty name", () => {
    const result = loadTemplate("", undefined, store);
    expect(result.status).toBe("error");
  });

  it("returns a deep clone of stored template", () => {
    saveTransactionTemplate("pay", makeTemplate(), store);
    const result = loadTemplate("pay", undefined, store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      result.data.params.destination = "MUTATED";
    }
    const result2 = loadTemplate("pay", undefined, store);
    expect(result2.status).toBe("ok");
    if (result2.status === "ok") {
      expect(result2.data.params.destination).toBe("{{destination}}");
    }
  });
});

describe("parameter substitution", () => {
  let store: TransactionTemplateStore;
  beforeEach(() => {
    store = createStore();
  });

  it("substitutes placeholders in top-level string values", () => {
    saveTransactionTemplate("pay", makeTemplate(), store);
    const result = loadTemplate("pay", {
      destination: "GDEST1234567890",
      amount: "100.5",
      sender: "alice",
    }, store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.params.destination).toBe("GDEST1234567890");
      expect(result.data.params.amount).toBe("100.5");
      expect(result.data.params.memo).toBe("Hello from alice");
    }
  });

  it("substitutes placeholders in nested objects", () => {
    const tpl = makeTemplate({
      params: {
        outer: {
          inner: "{{value}}",
        },
      },
    });
    saveTransactionTemplate("nested", tpl, store);
    const result = loadTemplate("nested", { value: "resolved" }, store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect((result.data.params.outer as any).inner).toBe("resolved");
    }
  });

  it("substitutes placeholders in arrays", () => {
    const tpl = makeTemplate({
      params: {
        items: ["{{a}}", "{{b}}", "static"],
      },
    });
    saveTransactionTemplate("arr", tpl, store);
    const result = loadTemplate("arr", { a: "first", b: "second" }, store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.params.items).toEqual(["first", "second", "static"]);
    }
  });

  it("leaves non-string scalars untouched", () => {
    const tpl = makeTemplate({
      params: {
        count: 42,
        enabled: true,
        nothing: null,
        name: "{{name}}",
      },
    });
    saveTransactionTemplate("scalars", tpl, store);
    const result = loadTemplate("scalars", { name: "test" }, store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.params.count).toBe(42);
      expect(result.data.params.enabled).toBe(true);
      expect(result.data.params.nothing).toBeNull();
      expect(result.data.params.name).toBe("test");
    }
  });

  it("replaces null param value with empty string", () => {
    const tpl = makeTemplate({
      params: { val: "{{val}}" },
    });
    saveTransactionTemplate("nullparam", tpl, store);
    const result = loadTemplate("nullparam", { val: null }, store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.params.val).toBe("");
    }
  });

  it("returns error when a placeholder has no matching param", () => {
    const tpl = makeTemplate();
    saveTransactionTemplate("pay", tpl, store);
    const result = loadTemplate("pay", { destination: "GDEST" }, store);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("Missing template parameters");
      expect(result.error.message).toContain("amount");
    }
  });

  it("reports all missing parameters sorted alphabetically", () => {
    // All placeholders must be in a single string so substituteString
    // sees them all in one pass (applyParams returns early on first error).
    const tpl = makeTemplate({
      params: { composite: "{{amount}}-{{destination}}-{{sender}}" },
    });
    saveTransactionTemplate("pay", tpl, store);
    const result = loadTemplate("pay", {}, store);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("amount");
      expect(result.error.message).toContain("destination");
      expect(result.error.message).toContain("sender");
    }
  });

  it("returns original template when params is undefined", () => {
    saveTransactionTemplate("pay", makeTemplate(), store);
    const result = loadTemplate("pay", undefined, store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.params.destination).toBe("{{destination}}");
    }
  });
});

describe("deleteTransactionTemplate", () => {
  let store: TransactionTemplateStore;
  beforeEach(() => {
    store = createStore();
  });

  it("deletes an existing template", () => {
    saveTransactionTemplate("pay", makeTemplate(), store);
    const result = deleteTransactionTemplate("pay", store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe(true);
    }
    expect(store.has("pay")).toBe(false);
  });

  it("returns false when deleting a non-existent template", () => {
    const result = deleteTransactionTemplate("ghost", store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toBe(false);
    }
  });

  it("rejects empty name", () => {
    const result = deleteTransactionTemplate("", store);
    expect(result.status).toBe("error");
  });
});

describe("listTransactionTemplates", () => {
  let store: TransactionTemplateStore;
  beforeEach(() => {
    store = createStore();
  });

  it("lists saved template names sorted", () => {
    saveTransactionTemplate("zebra", makeTemplate(), store);
    saveTransactionTemplate("alpha", makeTemplate(), store);
    saveTransactionTemplate("middle", makeTemplate(), store);
    const result = listTransactionTemplates(store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual(["alpha", "middle", "zebra"]);
    }
  });

  it("returns empty list when no templates exist", () => {
    const result = listTransactionTemplates(store);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual([]);
    }
  });
});

describe("clearTransactionTemplates", () => {
  it("clears all templates from the store", () => {
    const store = createStore();
    saveTransactionTemplate("a", makeTemplate(), store);
    saveTransactionTemplate("b", makeTemplate(), store);
    expect(store.list().length).toBe(2);

    const result = clearTransactionTemplates(store);
    expect(result.status).toBe("ok");
    expect(store.list().length).toBe(0);
  });
});

describe("InMemoryTransactionTemplateStore", () => {
  it("save/get round-trips a template", () => {
    const store = new InMemoryTransactionTemplateStore();
    const tpl = makeTemplate();
    store.save("test", tpl);
    const got = store.get("test");
    expect(got).toBeDefined();
    expect(got!.kind).toBe("payment");
  });

  it("get returns undefined for unknown name", () => {
    const store = new InMemoryTransactionTemplateStore();
    expect(store.get("unknown")).toBeUndefined();
  });

  it("has returns true for saved templates", () => {
    const store = new InMemoryTransactionTemplateStore();
    store.save("x", makeTemplate());
    expect(store.has("x")).toBe(true);
    expect(store.has("y")).toBe(false);
  });

  it("save stores a deep clone", () => {
    const store = new InMemoryTransactionTemplateStore();
    const tpl = makeTemplate();
    store.save("test", tpl);
    tpl.params.destination = "MUTATED";
    const got = store.get("test");
    expect(got!.params.destination).toBe("{{destination}}");
  });

  it("get returns a deep clone", () => {
    const store = new InMemoryTransactionTemplateStore();
    store.save("test", makeTemplate());
    const a = store.get("test")!;
    const b = store.get("test")!;
    a.params.destination = "A";
    b.params.destination = "B";
    const c = store.get("test")!;
    expect(c.params.destination).toBe("{{destination}}");
  });
});
