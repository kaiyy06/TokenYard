import { describe, expect, it } from "vitest";
import { captureBody, redactHeaders } from "../src/capture.js";

describe("redactHeaders", () => {
  it("redacts credentials but keeps the scheme and key kind", () => {
    const headers = redactHeaders({
      authorization: "Bearer sk-ant-oat01-abcdefghijklmnopqrstuvwxyz",
      "x-api-key": "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      cookie: "session=abc",
      "set-cookie": ["a=1", "b=2"],
      "anthropic-version": "2023-06-01",
    });
    expect(headers).toEqual({
      authorization: "Bearer sk-ant-oat01-[redacted]",
      "x-api-key": "sk-ant-api03-[redacted]",
      cookie: "[redacted]",
      "set-cookie": ["[redacted]", "[redacted]"],
      "anthropic-version": "2023-06-01",
    });
  });

  it("keeps rate-limit headers that mention tokens", () => {
    const headers = redactHeaders({ "anthropic-ratelimit-tokens-remaining": "1000" });
    expect(headers["anthropic-ratelimit-tokens-remaining"]).toBe("1000");
  });
});

describe("captureBody", () => {
  it("stores UTF-8 as text and anything else as base64", () => {
    expect(captureBody(Buffer.from("héllo"))).toEqual({
      data: "héllo",
      encoding: "utf8",
      bytes: 6,
    });
    expect(captureBody(Buffer.from([0xff, 0xfe]))).toEqual({
      data: "//4=",
      encoding: "base64",
      bytes: 2,
    });
  });
});
