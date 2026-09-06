import { test, expect } from "bun:test";
import { redactSensitiveText } from "../src/redact.ts";

const github = `ghp_${"Ab3".repeat(10)}`;
const honcho = `hch-${"Qw7".repeat(8)}`;
const jwt = `eyJ${"a".repeat(10)}.${"b".repeat(12)}.${"c".repeat(14)}`;

test("redacts common provider credentials while preserving surrounding prose", () => {
  const input = `Use ${github} for the existing integration and keep the project name atlas.`;
  const output = redactSensitiveText(input);
  expect(output).toBe("Use [REDACTED] for the existing integration and keep the project name atlas.");
  expect(output).not.toContain(github);
});

test("redacts JSON, env, header, CLI, URL, cookie, JWT, and PEM forms", () => {
  const samples = [
    `{"apiKey":"${honcho}","project":"atlas"}`,
    `ACCESS_TOKEN=${github}\nSAFE_NAME=atlas`,
    `Authorization: Bearer ${honcho}`,
    `Cookie: session=${honcho}; theme=dark`,
    `tool --client-secret ${honcho} --mode safe`,
    `https://user:${honcho}@example.test/path`,
    `https://example.test/?api_key=${honcho}&page=2`,
    jwt,
    `-----BEGIN PRIVATE KEY-----\n${honcho}\n-----END PRIVATE KEY-----`,
  ];
  for (const sample of samples) {
    const output = redactSensitiveText(sample);
    expect(output).not.toContain(honcho);
    expect(output).not.toContain(github);
    expect(output).not.toContain(jwt);
  }
});

test("keeps redacted JSON syntactically valid", () => {
  const output = redactSensitiveText(JSON.stringify({ apiKey: honcho, project: "atlas" }));
  expect(JSON.parse(output)).toEqual({ apiKey: "[REDACTED]", project: "atlas" });
});

test("redacts opaque values behind quoted JSON keys", () => {
  const input = JSON.stringify({ api_key: "opaque-value", Cookie: "session=opaque", project: "atlas" });
  expect(JSON.parse(redactSensitiveText(input))).toEqual({
    api_key: "[REDACTED]",
    Cookie: "[REDACTED]",
    project: "atlas",
  });
});

test("redacts prefixed environment keys and opaque X cookie fields", () => {
  const input = [
    "N8N_API_KEY=opaque-n8n-value",
    "CT0=opaque-csrf-cookie",
    "AUTH_TOKEN=opaque-auth-cookie",
    "TWID=opaque-account-cookie",
    "SAFE_NAME=atlas",
  ].join("\n");
  const output = redactSensitiveText(input);
  expect(output).toContain("N8N_API_KEY=[REDACTED]");
  expect(output).toContain("CT0=[REDACTED]");
  expect(output).toContain("AUTH_TOKEN=[REDACTED]");
  expect(output).toContain("TWID=[REDACTED]");
  expect(output).toContain("SAFE_NAME=atlas");
  expect(output).not.toContain("opaque-");
});

test("redacts complete Authorization headers for opaque schemes", () => {
  const input = [
    "Authorization: Token opaque-primary-credential",
    "Proxy-Authorization: Digest opaque-proxy-credential",
    "X-Request-ID: public-request-id",
  ].join("\n");
  const output = redactSensitiveText(input);
  expect(output).toContain("Authorization: [REDACTED]");
  expect(output).toContain("Proxy-Authorization: [REDACTED]");
  expect(output).toContain("X-Request-ID: public-request-id");
  expect(output).not.toContain("opaque-");
});

test("redacts JSON strings containing escaped quotes without breaking JSON", () => {
  const input = JSON.stringify({ password: 'prefix"suffix', nested: { N8N_API_KEY: "opaque" }, safe: "atlas" });
  const output = redactSensitiveText(input);
  expect(JSON.parse(output)).toEqual({ password: "[REDACTED]", nested: { N8N_API_KEY: "[REDACTED]" }, safe: "atlas" });
});

test("preserves safe JSON byte-for-byte, including large integers and duplicate keys", () => {
  const input = `{
  "safe": "atlas",
  "large_id": 900719925474099312345,
  "duplicate": 1,
  "duplicate": 2
}`;
  expect(redactSensitiveText(input)).toBe(input);
});

test("redacts quoted CLI secret arguments including spaces", () => {
  const output = redactSensitiveText(`deploy --password "prefix suffix" --client-secret 'other value' --mode safe`);
  expect(output).toBe(`deploy --password "[REDACTED]" --client-secret '[REDACTED]' --mode safe`);
});

test("does not erase ordinary ids, paths, prose, or code", () => {
  const input = "Session 00000000-0000-4000-8000-000000000000 edits src/auth.ts for project atlas.";
  expect(redactSensitiveText(input)).toBe(input);
});

test("is idempotent", () => {
  const once = redactSensitiveText(`api_key=${honcho}`);
  expect(redactSensitiveText(once)).toBe(once);
});
