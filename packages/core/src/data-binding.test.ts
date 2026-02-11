import { describe, it, expect } from "vitest";
import {
  isDataBinding,
  isJsonPointerBinding,
  isLogicExpressionBinding,
  isBindingExpression,
  dataPathToJsonPointer,
  jsonPointerToDataPath,
  resolveBindingExpression,
  resolveVisibilityBinding,
  resolveBindings,
  resolveBindingsDeep,
  BindingExpressionSchema,
} from "./data-binding";

// =============================================================================
// Type Guards
// =============================================================================

describe("isDataBinding", () => {
  it("returns true for $data strings", () => {
    expect(isDataBinding("$data")).toBe(true);
    expect(isDataBinding("$data.user.name")).toBe(true);
    expect(isDataBinding("$data.items.0.title")).toBe(true);
  });

  it("returns false for non-$data values", () => {
    expect(isDataBinding("/user/name")).toBe(false);
    expect(isDataBinding("hello")).toBe(false);
    expect(isDataBinding(42)).toBe(false);
    expect(isDataBinding(null)).toBe(false);
    expect(isDataBinding({ path: "/x" })).toBe(false);
  });
});

describe("isJsonPointerBinding", () => {
  it("returns true for strings starting with /", () => {
    expect(isJsonPointerBinding("/")).toBe(true);
    expect(isJsonPointerBinding("/user/name")).toBe(true);
    expect(isJsonPointerBinding("/items/0")).toBe(true);
  });

  it("returns false for non-pointer values", () => {
    expect(isJsonPointerBinding("$data.x")).toBe(false);
    expect(isJsonPointerBinding("hello")).toBe(false);
    expect(isJsonPointerBinding(42)).toBe(false);
    expect(isJsonPointerBinding(null)).toBe(false);
  });
});

describe("isLogicExpressionBinding", () => {
  it("returns true for logic expression objects", () => {
    expect(isLogicExpressionBinding({ eq: [1, 1] })).toBe(true);
    expect(isLogicExpressionBinding({ neq: [1, 2] })).toBe(true);
    expect(isLogicExpressionBinding({ gt: [5, 3] })).toBe(true);
    expect(isLogicExpressionBinding({ gte: [5, 5] })).toBe(true);
    expect(isLogicExpressionBinding({ lt: [3, 5] })).toBe(true);
    expect(isLogicExpressionBinding({ lte: [5, 5] })).toBe(true);
    expect(isLogicExpressionBinding({ and: [{ eq: [1, 1] }] })).toBe(true);
    expect(isLogicExpressionBinding({ or: [{ eq: [1, 1] }] })).toBe(true);
    expect(isLogicExpressionBinding({ not: { eq: [1, 2] } })).toBe(true);
    expect(isLogicExpressionBinding({ path: "/isAdmin" })).toBe(true);
  });

  it("returns false for non-logic-expression values", () => {
    expect(isLogicExpressionBinding("$data.x")).toBe(false);
    expect(isLogicExpressionBinding("/user/name")).toBe(false);
    expect(isLogicExpressionBinding(42)).toBe(false);
    expect(isLogicExpressionBinding(null)).toBe(false);
    expect(isLogicExpressionBinding({})).toBe(false);
    expect(isLogicExpressionBinding({ foo: "bar" })).toBe(false);
  });
});

describe("isBindingExpression", () => {
  it("returns true for any binding form", () => {
    expect(isBindingExpression("$data.user.name")).toBe(true);
    expect(isBindingExpression("/user/name")).toBe(true);
    expect(isBindingExpression({ eq: [1, 1] })).toBe(true);
  });

  it("returns false for plain literals", () => {
    expect(isBindingExpression("hello")).toBe(false);
    expect(isBindingExpression(42)).toBe(false);
    expect(isBindingExpression(true)).toBe(false);
    expect(isBindingExpression(null)).toBe(false);
  });
});

// =============================================================================
// Path Conversion
// =============================================================================

describe("dataPathToJsonPointer", () => {
  it("converts $data to root pointer", () => {
    expect(dataPathToJsonPointer("$data")).toBe("/");
  });

  it("converts simple dot paths", () => {
    expect(dataPathToJsonPointer("$data.user")).toBe("/user");
    expect(dataPathToJsonPointer("$data.user.name")).toBe("/user/name");
  });

  it("converts paths with array indices", () => {
    expect(dataPathToJsonPointer("$data.items.0")).toBe("/items/0");
    expect(dataPathToJsonPointer("$data.items.0.title")).toBe("/items/0/title");
  });

  it("handles deeply nested paths", () => {
    expect(dataPathToJsonPointer("$data.a.b.c.d.e")).toBe("/a/b/c/d/e");
  });

  it("escapes JSON Pointer special characters in segments", () => {
    // A segment containing / needs ~1 escaping in JSON Pointer
    expect(dataPathToJsonPointer("$data.a\\.b")).toBe("/a.b");
  });

  it("handles $data. with empty rest as root", () => {
    expect(dataPathToJsonPointer("$data.")).toBe("/");
  });
});

describe("jsonPointerToDataPath", () => {
  it("converts root pointer to $data", () => {
    expect(jsonPointerToDataPath("/")).toBe("$data");
    expect(jsonPointerToDataPath("")).toBe("$data");
  });

  it("converts simple pointer paths", () => {
    expect(jsonPointerToDataPath("/user")).toBe("$data.user");
    expect(jsonPointerToDataPath("/user/name")).toBe("$data.user.name");
  });

  it("converts paths with array indices", () => {
    expect(jsonPointerToDataPath("/items/0")).toBe("$data.items.0");
    expect(jsonPointerToDataPath("/items/0/title")).toBe("$data.items.0.title");
  });

  it("escapes dots in segment names", () => {
    // JSON Pointer segment "config.json" → $data path needs escaped dot
    expect(jsonPointerToDataPath("/config.json")).toBe("$data.config\\.json");
  });
});

describe("round-trip conversion", () => {
  it("$data → pointer → $data preserves path", () => {
    const paths = [
      "$data",
      "$data.user",
      "$data.user.name",
      "$data.items.0.title",
      "$data.a.b.c",
    ];
    for (const path of paths) {
      const pointer = dataPathToJsonPointer(path);
      const back = jsonPointerToDataPath(pointer);
      expect(back).toBe(path);
    }
  });

  it("pointer → $data → pointer preserves path", () => {
    const pointers = ["/", "/user", "/user/name", "/items/0/title", "/a/b/c"];
    for (const pointer of pointers) {
      const dataPath = jsonPointerToDataPath(pointer);
      const back = dataPathToJsonPointer(dataPath);
      expect(back).toBe(pointer);
    }
  });
});

// =============================================================================
// Resolution
// =============================================================================

describe("resolveBindingExpression", () => {
  const state = {
    user: { name: "Alice", age: 30 },
    items: [
      { id: "1", title: "First" },
      { id: "2", title: "Second" },
    ],
    count: 5,
    active: true,
    label: "Hello",
  };

  describe("$data bindings", () => {
    it("resolves $data to root state", () => {
      expect(resolveBindingExpression("$data", state)).toBe(state);
    });

    it("resolves $data dot-notation paths", () => {
      expect(resolveBindingExpression("$data.user.name", state)).toBe("Alice");
      expect(resolveBindingExpression("$data.user.age", state)).toBe(30);
      expect(resolveBindingExpression("$data.count", state)).toBe(5);
      expect(resolveBindingExpression("$data.active", state)).toBe(true);
    });

    it("resolves $data paths into arrays", () => {
      expect(resolveBindingExpression("$data.items.0.title", state)).toBe(
        "First",
      );
      expect(resolveBindingExpression("$data.items.1.id", state)).toBe("2");
    });

    it("returns undefined for missing $data paths", () => {
      expect(
        resolveBindingExpression("$data.nonexistent", state),
      ).toBeUndefined();
      expect(
        resolveBindingExpression("$data.user.missing", state),
      ).toBeUndefined();
    });
  });

  describe("JSON Pointer bindings", () => {
    it("resolves JSON Pointer paths", () => {
      expect(resolveBindingExpression("/user/name", state)).toBe("Alice");
      expect(resolveBindingExpression("/count", state)).toBe(5);
      expect(resolveBindingExpression("/items/0/title", state)).toBe("First");
    });

    it("resolves root pointer", () => {
      expect(resolveBindingExpression("/", state)).toBe(state);
    });

    it("returns undefined for missing pointer paths", () => {
      expect(resolveBindingExpression("/nonexistent", state)).toBeUndefined();
    });
  });

  describe("LogicExpression bindings", () => {
    it("evaluates equality expressions", () => {
      expect(
        resolveBindingExpression({ eq: [{ path: "/count" }, 5] }, state),
      ).toBe(true);
      expect(
        resolveBindingExpression({ eq: [{ path: "/count" }, 10] }, state),
      ).toBe(false);
    });

    it("evaluates comparison expressions", () => {
      expect(
        resolveBindingExpression({ gt: [{ path: "/count" }, 3] }, state),
      ).toBe(true);
      expect(
        resolveBindingExpression({ lt: [{ path: "/count" }, 3] }, state),
      ).toBe(false);
    });

    it("evaluates boolean logic", () => {
      expect(
        resolveBindingExpression(
          {
            and: [{ eq: [{ path: "/count" }, 5] }, { path: "/active" }],
          },
          state,
        ),
      ).toBe(true);
      expect(
        resolveBindingExpression(
          {
            or: [{ eq: [{ path: "/count" }, 99] }, { path: "/active" }],
          },
          state,
        ),
      ).toBe(true);
    });

    it("evaluates not expressions", () => {
      expect(
        resolveBindingExpression(
          { not: { eq: [{ path: "/count" }, 99] } },
          state,
        ),
      ).toBe(true);
    });

    it("evaluates path truthiness", () => {
      expect(resolveBindingExpression({ path: "/active" }, state)).toBe(true);
      expect(resolveBindingExpression({ path: "/nonexistent" }, state)).toBe(
        false,
      );
    });
  });

  describe("literal passthrough", () => {
    it("passes through literal strings", () => {
      expect(resolveBindingExpression("hello", state)).toBe("hello");
      expect(resolveBindingExpression("world", state)).toBe("world");
    });

    it("passes through literal numbers", () => {
      expect(resolveBindingExpression(42, state)).toBe(42);
      expect(resolveBindingExpression(0, state)).toBe(0);
    });

    it("passes through literal booleans", () => {
      expect(resolveBindingExpression(true, state)).toBe(true);
      expect(resolveBindingExpression(false, state)).toBe(false);
    });

    it("passes through null", () => {
      expect(
        resolveBindingExpression(null as unknown as string, state),
      ).toBeNull();
    });
  });
});

// =============================================================================
// Visibility Resolution
// =============================================================================

describe("resolveVisibilityBinding", () => {
  const state = { active: true, count: 0, name: "" };

  it("returns true for undefined", () => {
    expect(resolveVisibilityBinding(undefined, state)).toBe(true);
  });

  it("returns boolean literals directly", () => {
    expect(resolveVisibilityBinding(true, state)).toBe(true);
    expect(resolveVisibilityBinding(false, state)).toBe(false);
  });

  it("resolves $data path to truthiness", () => {
    expect(resolveVisibilityBinding("$data.active", state)).toBe(true);
    expect(resolveVisibilityBinding("$data.count", state)).toBe(false);
    expect(resolveVisibilityBinding("$data.name", state)).toBe(false);
  });

  it("resolves JSON Pointer to truthiness", () => {
    expect(resolveVisibilityBinding("/active", state)).toBe(true);
    expect(resolveVisibilityBinding("/count", state)).toBe(false);
  });

  it("evaluates LogicExpression objects", () => {
    expect(resolveVisibilityBinding({ path: "/active" }, state)).toBe(true);
    expect(
      resolveVisibilityBinding({ eq: [{ path: "/count" }, 0] }, state),
    ).toBe(true);
  });

  it("returns false for missing paths", () => {
    expect(resolveVisibilityBinding("$data.missing", state)).toBe(false);
    expect(resolveVisibilityBinding("/missing", state)).toBe(false);
  });
});

// =============================================================================
// Batch Resolution
// =============================================================================

describe("resolveBindings", () => {
  const state = { user: { name: "Alice" }, count: 5 };

  it("resolves mixed binding types in a props object", () => {
    const result = resolveBindings(
      {
        name: "$data.user.name",
        count: "/count",
        label: "static",
        visible: true,
      },
      state,
    );

    expect(result).toEqual({
      name: "Alice",
      count: 5,
      label: "static",
      visible: true,
    });
  });

  it("handles empty props", () => {
    expect(resolveBindings({}, state)).toEqual({});
  });
});

describe("resolveBindingsDeep", () => {
  const state = {
    user: { name: "Alice" },
    theme: { primary: "#007AFF" },
    count: 5,
  };

  it("resolves bindings in nested objects", () => {
    const result = resolveBindingsDeep(
      {
        header: {
          title: "$data.user.name",
          color: "/theme/primary",
        },
        static: "hello",
      },
      state,
    );

    expect(result).toEqual({
      header: {
        title: "Alice",
        color: "#007AFF",
      },
      static: "hello",
    });
  });

  it("resolves bindings in arrays", () => {
    const result = resolveBindingsDeep(
      ["$data.user.name", "/count", "literal"],
      state,
    );

    expect(result).toEqual(["Alice", 5, "literal"]);
  });

  it("resolves bindings in deeply nested structures", () => {
    const result = resolveBindingsDeep(
      {
        level1: {
          level2: {
            value: "$data.count",
          },
          items: ["/user/name", "$data.theme.primary"],
        },
      },
      state,
    );

    expect(result).toEqual({
      level1: {
        level2: { value: 5 },
        items: ["Alice", "#007AFF"],
      },
    });
  });

  it("resolves LogicExpressions in nested structures", () => {
    const result = resolveBindingsDeep(
      {
        isHighCount: { gt: [{ path: "/count" }, 3] },
        name: "$data.user.name",
      },
      state,
    );

    expect(result).toEqual({
      isHighCount: true,
      name: "Alice",
    });
  });

  it("passes through null and undefined", () => {
    expect(resolveBindingsDeep(null, state)).toBeNull();
    expect(resolveBindingsDeep(undefined, state)).toBeUndefined();
  });

  it("passes through primitive literals", () => {
    expect(resolveBindingsDeep(42, state)).toBe(42);
    expect(resolveBindingsDeep(true, state)).toBe(true);
    expect(resolveBindingsDeep("hello", state)).toBe("hello");
  });
});

// =============================================================================
// Zod Schema Validation
// =============================================================================

describe("BindingExpressionSchema", () => {
  it("accepts $data strings", () => {
    expect(BindingExpressionSchema.safeParse("$data.user.name").success).toBe(
      true,
    );
  });

  it("accepts JSON Pointer strings", () => {
    expect(BindingExpressionSchema.safeParse("/user/name").success).toBe(true);
  });

  it("accepts plain strings", () => {
    expect(BindingExpressionSchema.safeParse("hello").success).toBe(true);
  });

  it("accepts numbers", () => {
    expect(BindingExpressionSchema.safeParse(42).success).toBe(true);
  });

  it("accepts booleans", () => {
    expect(BindingExpressionSchema.safeParse(true).success).toBe(true);
    expect(BindingExpressionSchema.safeParse(false).success).toBe(true);
  });

  it("accepts null", () => {
    expect(BindingExpressionSchema.safeParse(null).success).toBe(true);
  });

  it("accepts LogicExpression objects", () => {
    expect(BindingExpressionSchema.safeParse({ eq: [1, 1] }).success).toBe(
      true,
    );
    expect(
      BindingExpressionSchema.safeParse({
        and: [{ path: "/x" }, { eq: [1, 1] }],
      }).success,
    ).toBe(true);
  });
});
