import { describe, expect, test } from "bun:test";
import { redact } from "../src/redact.ts";
const R = "[redacted]";

describe("redact key=value pass", () => {
  const forms = [
    ["password: vaaaa", "password: [redacted]"],
    ["passwd=vaaaa", "passwd=[redacted]"],
    ["secret = vaaaa", "secret = [redacted]"],
    ["token=vaaaa", "token=[redacted]"],
    ["api_key:vaaaa", "api_key:[redacted]"],
    ["api-key=vaaaa", "api-key=[redacted]"],
    ["secret_key: vaaaa", "secret_key: [redacted]"],
    ["secret-key=vaaaa", "secret-key=[redacted]"],
    ["SecretKey=vaaaa", "SecretKey=[redacted]"],
    ["PASSWORD : vaaaa", "PASSWORD : [redacted]"],
    ["GITHUB_TOKEN=vaaaa", "GITHUB_TOKEN=[redacted]"],
  ];
  test.each(forms)("masks the value of %s", (input, output) => {
    expect(redact(`before ${input} after`)).toBe(`before ${output} after`);
  });
  test("keeps existing token formats redacted inside key=value forms", () => {
    expect(redact(`token=sk-${"A".repeat(16)} next`)).toBe("token=[redacted] next");
    expect(redact(`see sk-${"A".repeat(16)} and password: vaaaa`)).toBe("see [redacted] and password: [redacted]");
  });
  test("masks JSON and quoted keys and whole quoted values", () => {
    expect(redact('Config is {"password": "vaaaa", "api_key": "vbbbb"} and token: "q w" ok'))
      .toBe(`Config is {"password": "${R}", "api_key": "${R}"} and token: "${R}" ok`);
    expect(redact("{'token': 'vaaaa', 'secret':'v v'}")).toBe(`{'token': '${R}', 'secret':'${R}'}`);
    expect(redact('password="m w v" next')).toBe(`password="${R}" next`);
    expect(redact('"tokens": 5, "max_tokens": 500')).toBe('"tokens": 5, "max_tokens": 500');
  });
  test("masks escaped-quote JSON values, bearer credentials and camelCase keys", () => {
    expect(redact('{"password": "a\\"b c", "n": 1}')).toBe(`{"password": "${R}", "n": 1}`);
    expect(redact("Authorization: Bearer abcdEFGH1234ijkl next")).toBe("Authorization: Bearer [redacted] next");
    expect(redact("sent Bearer abcdEFGH1234ijklmn here")).toBe("sent Bearer [redacted] here");
    expect(redact("apiKey: vaaaa and accessToken=vbbbb")).toBe("apiKey: [redacted] and accessToken=[redacted]");
  });
  test("leaves benign prose unchanged", () => {
    for (const prose of ["token budget is 500 tokens", "The secretary will review the password policy tomorrow.",
      "max_tokens is 500", "Rotate the API key next week; secrets live in the vault.", "ratio 3:2 and a=b",
      "Bearer authentication is used", "the Bearer of bad news", "Authorization header is required"])
      expect(redact(prose)).toBe(prose);
  });
});
