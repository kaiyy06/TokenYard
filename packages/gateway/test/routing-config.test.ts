import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseRoutingSettings } from "../src/routing/config.js";

describe("parseRoutingSettings", () => {
  it("fills every default from an empty file", () => {
    const s = parseRoutingSettings({});
    expect(s.mode).toBe("shadow");
    expect(s.decider).toMatchObject({ provider: "openrouter", timeoutMs: 800, maxChars: 4000 });
    expect(s.policy).toEqual({
      upgradeMinConfidence: 0.5,
      downgradeMinConfidence: 0.75,
      taskChangedThreshold: 0.7,
    });
    expect(s.tiers.anthropic.standard).toBe("claude-sonnet-5-5");
    expect(s.tiers.openai).toBeUndefined();
  });

  it("reads the snake_case file format", () => {
    const s = parseRoutingSettings({
      mode: "route",
      decider: {
        provider: "kev-local",
        timeout_ms: 300,
        send: { max_chars: 100, include_tool_names: false },
      },
      policy: { downgrade_min_confidence: 0.9, expected_remaining_turns: 3 },
      tiers: { openai: { fast: "a", standard: "b", frontier: "c" } },
    });
    expect(s).toMatchObject({
      mode: "route",
      decider: { provider: "kev-local", timeoutMs: 300, maxChars: 100, includeToolNames: false },
      expectedRemainingTurns: 3,
      tiers: { openai: { fast: "a", standard: "b", frontier: "c" } },
    });
    expect(s.policy.downgradeMinConfidence).toBe(0.9);
  });

  it("lists every problem in one error, including unknown keys", () => {
    expect(() =>
      parseRoutingSettings({ mode: "fast", policy: { upgrade_min_confidence: 2 }, surprise: 1 }),
    ).toThrow(/mode[\s\S]*policy\.upgrade_min_confidence[\s\S]*/);
    expect(() => parseRoutingSettings({ surprise: 1 })).toThrow(/invalid config/);
  });

  it("treats an empty file as defaults and has an off default for no file", () => {
    expect(parseRoutingSettings(null).mode).toBe("shadow");
    expect(DEFAULT_SETTINGS.mode).toBe("off");
  });
});
