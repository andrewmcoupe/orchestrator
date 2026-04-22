// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSection } from "./useSection.js";

describe("useSection", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("defaults to tasks when hash is empty", () => {
    const { result } = renderHook(() => useSection());
    expect(result.current[0]).toBe("tasks");
  });

  it("parses a valid section from hash", () => {
    window.location.hash = "#/prompts";
    const { result } = renderHook(() => useSection());
    expect(result.current[0]).toBe("prompts");
  });

  it("defaults to tasks for unknown hash", () => {
    window.location.hash = "#/unknown";
    const { result } = renderHook(() => useSection());
    expect(result.current[0]).toBe("tasks");
  });

  it("navigate() updates the hash", () => {
    const { result } = renderHook(() => useSection());
    act(() => {
      result.current[1]("settings");
    });
    expect(window.location.hash).toBe("#/settings");
  });

  it("responds to hashchange events", async () => {
    const { result } = renderHook(() => useSection());
    expect(result.current[0]).toBe("tasks");

    await act(async () => {
      window.location.hash = "#/measurement";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(result.current[0]).toBe("measurement");
  });

  it("handles hash with nested path (e.g. #/tasks/T-001)", () => {
    window.location.hash = "#/tasks/T-001";
    const { result } = renderHook(() => useSection());
    expect(result.current[0]).toBe("tasks");
  });
});
