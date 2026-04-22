// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSelectedTaskId } from "./useSelectedTaskId.js";

describe("useSelectedTaskId", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("returns null when hash is #/tasks", () => {
    window.location.hash = "#/tasks";
    const { result } = renderHook(() => useSelectedTaskId());
    expect(result.current[0]).toBeNull();
  });

  it("extracts task ID from #/tasks/:id", () => {
    window.location.hash = "#/tasks/T-003";
    const { result } = renderHook(() => useSelectedTaskId());
    expect(result.current[0]).toBe("T-003");
  });

  it("returns null for non-task hashes", () => {
    window.location.hash = "#/prompts";
    const { result } = renderHook(() => useSelectedTaskId());
    expect(result.current[0]).toBeNull();
  });

  it("selectTask updates hash to #/tasks/:id", () => {
    const { result } = renderHook(() => useSelectedTaskId());
    act(() => result.current[1]("T-007"));
    expect(window.location.hash).toBe("#/tasks/T-007");
  });

  it("selectTask(null) navigates to #/tasks", () => {
    window.location.hash = "#/tasks/T-003";
    const { result } = renderHook(() => useSelectedTaskId());
    act(() => result.current[1](null));
    expect(window.location.hash).toBe("#/tasks");
  });

  it("responds to hashchange events", async () => {
    const { result } = renderHook(() => useSelectedTaskId());
    expect(result.current[0]).toBeNull();

    await act(async () => {
      window.location.hash = "#/tasks/T-010";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(result.current[0]).toBe("T-010");
  });
});
