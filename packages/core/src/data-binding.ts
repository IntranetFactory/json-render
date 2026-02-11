import { z } from "zod";
import type { StateModel, LogicExpression } from "./types";
import { getByPath } from "./types";
import {
  LogicExpressionSchema,
  evaluateLogicExpression,
  type VisibilityContext,
} from "./visibility";

// =============================================================================
// Unified Data Binding Expression
// =============================================================================

/**
 * A unified binding expression that resolves to a value from the state model.
 *
 * Three forms are supported:
 *
 * 1. **`$data` binding** (string starting with `$data`):
 *    Simple dot-notation path into the state model.
 *    `"$data.user.name"` reads state at `/user/name`.
 *    `"$data"` reads the entire state model (root).
 *
 * 2. **JSON Pointer** (string starting with `/`):
 *    RFC 6901 JSON Pointer path into the state model.
 *    `"/user/name"` reads state at `/user/name`.
 *    Supports standard escaping: `~0` for `~`, `~1` for `/`.
 *
 * 3. **Logic Expression** (object):
 *    A `LogicExpression` object for complex conditions.
 *    `{ "eq": ["/count", 5] }` evaluates to a boolean.
 *    Supports `and`, `or`, `not`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, and `path`.
 */
export type BindingExpression<T = unknown> = T | LogicExpression;

/**
 * Zod schema for a binding expression.
 *
 * Accepts:
 * - Strings (including `$data.*` and `/pointer` paths)
 * - Numbers, booleans, null (literal values)
 * - LogicExpression objects
 */
export const BindingExpressionSchema: z.ZodType<BindingExpression> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  LogicExpressionSchema,
]);

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a value is a `$data` dot-notation binding.
 *
 * @example
 * isDataBinding("$data.user.name") // true
 * isDataBinding("$data")           // true
 * isDataBinding("/user/name")      // false
 * isDataBinding(42)                // false
 */
export function isDataBinding(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("$data");
}

/**
 * Check if a value is a JSON Pointer binding (starts with `/`).
 *
 * @example
 * isJsonPointerBinding("/user/name") // true
 * isJsonPointerBinding("/")          // true
 * isJsonPointerBinding("$data.x")    // false
 * isJsonPointerBinding(42)           // false
 */
export function isJsonPointerBinding(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/");
}

/**
 * Check if a value is a LogicExpression object.
 *
 * @example
 * isLogicExpressionBinding({ eq: [1, 1] })       // true
 * isLogicExpressionBinding({ and: [{ path: "/x" }] }) // true
 * isLogicExpressionBinding("/user/name")          // false
 */
export function isLogicExpressionBinding(
  value: unknown,
): value is LogicExpression {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  const logicKeys = [
    "and",
    "or",
    "not",
    "path",
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
  ];
  return logicKeys.some((k) => keys.includes(k));
}

/**
 * Check if a value is any kind of binding expression (not a plain literal).
 *
 * Returns `true` for `$data.*` strings, `/pointer` strings, and LogicExpression objects.
 * Returns `false` for plain literal values (non-path strings, numbers, booleans, null).
 */
export function isBindingExpression(value: unknown): boolean {
  return (
    isDataBinding(value) ||
    isJsonPointerBinding(value) ||
    isLogicExpressionBinding(value)
  );
}

// =============================================================================
// Path Conversion
// =============================================================================

/**
 * Convert a `$data` dot-notation path to a JSON Pointer (RFC 6901).
 *
 * @example
 * dataPathToJsonPointer("$data")            // "/"
 * dataPathToJsonPointer("$data.user.name")  // "/user/name"
 * dataPathToJsonPointer("$data.items.0")    // "/items/0"
 *
 * Dots in property names can be escaped with a backslash:
 * dataPathToJsonPointer("$data.config\\.json") // "/config.json"
 */
export function dataPathToJsonPointer(dataPath: string): string {
  if (dataPath === "$data") return "/";

  // Strip "$data." prefix
  const rest = dataPath.slice("$data.".length);
  if (!rest) return "/";

  // Split on unescaped dots, then unescape escaped dots
  const segments = splitOnUnescapedDots(rest);
  // Escape JSON Pointer special chars in each segment: ~ → ~0, / → ~1
  const escaped = segments.map((s) =>
    s.replace(/~/g, "~0").replace(/\//g, "~1"),
  );
  return "/" + escaped.join("/");
}

/**
 * Convert a JSON Pointer (RFC 6901) to a `$data` dot-notation path.
 *
 * @example
 * jsonPointerToDataPath("/")           // "$data"
 * jsonPointerToDataPath("/user/name")  // "$data.user.name"
 * jsonPointerToDataPath("/items/0")    // "$data.items.0"
 */
export function jsonPointerToDataPath(pointer: string): string {
  if (pointer === "/" || pointer === "") return "$data";
  const raw = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  // Unescape JSON Pointer: ~1 → /, ~0 → ~
  const segments = raw.split("/").map((s) => {
    const unescaped = s.replace(/~1/g, "/").replace(/~0/g, "~");
    // Escape dots in segment for $data notation
    return unescaped.replace(/\./g, "\\.");
  });
  return "$data." + segments.join(".");
}

/**
 * Split a string on unescaped dots (dots not preceded by backslash).
 */
function splitOnUnescapedDots(str: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\\" && i + 1 < str.length && str[i + 1] === ".") {
      current += ".";
      i++; // skip the dot
    } else if (str[i] === ".") {
      segments.push(current);
      current = "";
    } else {
      current += str[i];
    }
  }
  segments.push(current);
  return segments;
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve a unified binding expression against the state model.
 *
 * - `$data.*` strings are converted to JSON Pointers and resolved.
 * - `/pointer` strings are resolved directly as JSON Pointers.
 * - LogicExpression objects are evaluated to booleans.
 * - All other values are returned as-is (literal passthrough).
 *
 * @example
 * const state = { user: { name: "Alice" }, count: 5 };
 *
 * resolveBindingExpression("$data.user.name", state)  // "Alice"
 * resolveBindingExpression("/user/name", state)        // "Alice"
 * resolveBindingExpression("/count", state)             // 5
 * resolveBindingExpression({ eq: [{ path: "/count" }, 5] }, state)  // true
 * resolveBindingExpression("hello", state)              // "hello" (literal)
 * resolveBindingExpression(42, state)                   // 42 (literal)
 */
export function resolveBindingExpression<T>(
  expr: BindingExpression<T>,
  stateModel: StateModel,
): T | boolean | undefined {
  // $data dot-notation binding
  if (isDataBinding(expr)) {
    const pointer = dataPathToJsonPointer(expr as string);
    return getByPath(stateModel, pointer) as T | undefined;
  }

  // JSON Pointer binding
  if (isJsonPointerBinding(expr)) {
    return getByPath(stateModel, expr as string) as T | undefined;
  }

  // LogicExpression object binding
  if (isLogicExpressionBinding(expr)) {
    const ctx: VisibilityContext = { stateModel };
    return evaluateLogicExpression(expr as LogicExpression, ctx);
  }

  // Literal value passthrough
  return expr as T;
}

/**
 * Resolve a binding expression specifically for visibility (boolean result).
 *
 * Unlike `resolveBindingExpression`, this always returns a boolean:
 * - `$data.*` and `/pointer` paths resolve to truthiness of the value.
 * - LogicExpression objects evaluate to boolean.
 * - Boolean literals pass through.
 * - `undefined` returns `true` (no condition = visible).
 */
export function resolveVisibilityBinding(
  expr: BindingExpression | undefined,
  stateModel: StateModel,
  authState?: { isSignedIn: boolean },
): boolean {
  if (expr === undefined) return true;
  if (typeof expr === "boolean") return expr;

  // $data dot-notation binding → truthiness
  if (isDataBinding(expr)) {
    const pointer = dataPathToJsonPointer(expr as string);
    return Boolean(getByPath(stateModel, pointer));
  }

  // JSON Pointer binding → truthiness
  if (isJsonPointerBinding(expr)) {
    return Boolean(getByPath(stateModel, expr as string));
  }

  // LogicExpression object binding
  if (isLogicExpressionBinding(expr)) {
    const ctx: VisibilityContext = { stateModel, authState };
    return evaluateLogicExpression(expr as LogicExpression, ctx);
  }

  return Boolean(expr);
}

/**
 * Resolve all binding expressions within a props object (shallow).
 *
 * Iterates over each prop value and resolves any binding expressions.
 * Returns a new object with resolved values.
 */
export function resolveBindings(
  props: Record<string, unknown>,
  stateModel: StateModel,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    resolved[key] = resolveBindingExpression(value, stateModel);
  }
  return resolved;
}

/**
 * Recursively resolve all binding expressions in a nested value.
 *
 * Walks arrays and plain objects recursively, resolving any
 * binding expressions found at any depth.
 */
export function resolveBindingsDeep(
  value: unknown,
  stateModel: StateModel,
): unknown {
  if (value === null || value === undefined) return value;

  // Check binding expressions first (before generic object check)
  if (isDataBinding(value) || isJsonPointerBinding(value)) {
    return resolveBindingExpression(value, stateModel);
  }

  if (isLogicExpressionBinding(value)) {
    return resolveBindingExpression(value, stateModel);
  }

  // Arrays: resolve each element
  if (Array.isArray(value)) {
    return value.map((item) => resolveBindingsDeep(item, stateModel));
  }

  // Plain objects: resolve each value recursively
  if (typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] = resolveBindingsDeep(val, stateModel);
    }
    return resolved;
  }

  // Primitive literal: passthrough
  return value;
}
