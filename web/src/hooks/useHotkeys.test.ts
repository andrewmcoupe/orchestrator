// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useHotkeys } from "./useHotkeys.js";

describe("useHotkeys", () => {
  it("calls navigate with the correct section on ⌘1-5", () => {
    const navigate = vi.fn();
    renderHook(() => useHotkeys(navigate));

    const cases: Array<[string, string]> = [
      ["1", "tasks"],
      ["2", "prompts"],
      ["3", "providers"],
      ["4", "measurement"],
      ["5", "settings"],
    ];

    for (const [key, expected] of cases) {
      navigate.mockClear();
      const event = new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true });
      window.dispatchEvent(event);
      expect(navigate).toHaveBeenCalledWith(expected);
    }
  });

  it("ignores keys without meta/ctrl modifier", () => {
    const navigate = vi.fn();
    renderHook(() => useHotkeys(navigate));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("ignores unrelated keys", () => {
    const navigate = vi.fn();
    renderHook(() => useHotkeys(navigate));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("works with ctrl modifier too", () => {
    const navigate = vi.fn();
    renderHook(() => useHotkeys(navigate));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", ctrlKey: true, bubbles: true }));
    expect(navigate).toHaveBeenCalledWith("providers");
  });
});
