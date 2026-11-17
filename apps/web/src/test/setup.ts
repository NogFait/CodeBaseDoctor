import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";

// React only wraps state updates for `act()` warnings/batching when it sees
// this flag — Vitest's jsdom environment doesn't set it automatically the
// way Jest's does.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Node >= 25 ships an experimental global `localStorage` that is `undefined`
// unless `--localstorage-file` is passed, and it shadows jsdom's own Storage
// on `globalThis`. Real browsers are unaffected — this is a test-env quirk —
// so restore a working Storage here (jsdom's if reachable, else in-memory).
if (typeof globalThis.localStorage?.getItem !== "function") {
  const fromJsdom = typeof window !== "undefined" ? Object.getOwnPropertyDescriptor(window, "localStorage") : undefined;
  let storage: Storage | undefined;
  try {
    storage = fromJsdom?.get ? (fromJsdom.get.call(window) as Storage) : undefined;
  } catch {
    storage = undefined;
  }
  if (typeof storage?.getItem !== "function") {
    const data = new Map<string, string>();
    storage = {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (key: string) => data.get(key) ?? null,
      key: (index: number) => [...data.keys()][index] ?? null,
      removeItem: (key: string) => void data.delete(key),
      setItem: (key: string, value: string) => void data.set(key, String(value)),
    } as Storage;
  }
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}

// Extends vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.)
// AND augments vitest's `Assertion` type with them — the `/vitest` subpath
// does both, unlike importing "@testing-library/jest-dom/matchers" +
// `expect.extend()` by hand, which only covers the runtime half and leaves
// `tsc` unaware the matchers exist.

// This repo's test convention imports `describe`/`it`/`afterEach` explicitly
// from "vitest" (see apps/api's *.spec.ts) rather than enabling vitest's
// `globals` option. @testing-library/react's own auto-cleanup only
// self-registers when it detects a GLOBAL `afterEach`, so without globals
// enabled it silently never runs — each test's rendered tree accumulates in
// the jsdom document, and later tests' role/label queries start matching
// multiple stale elements. Registered once here instead.
afterEach(() => {
  cleanup();
});
