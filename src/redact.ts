const REDACTED = "[REDACTED]";

// Redaction is deliberately applied before durable queue writes and again at
// the upload boundary. It is heuristic rather than a data-loss-prevention
// guarantee, but it covers the credential formats most often pasted into chat.
const KNOWN_SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bGOCSPX-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bhch-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bxox[a-zA-Z]-[A-Za-z0-9-]{20,}\b/g,
  /\bsk_live_[A-Za-z0-9]{16,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
];

const SENSITIVE_SUFFIX =
  "api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret";
const SENSITIVE_KEY =
  `(?:[A-Za-z0-9]+[_-])*(?:${SENSITIVE_SUFFIX})|authorization|proxy-authorization|cookie|set-cookie|ct0|twid|guest[_-]?id|personalization[_-]?id|kdt|csrf[_-]?token|xsrf[_-]?token|x-csrf-token|x-xsrf-token`;
function redactUnstructuredText(input: string): string {
  if (!input) return input;
  let text = input;

  text = text.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
    `[PRIVATE KEY ${REDACTED}]`,
  );
  text = text.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, `[JWT ${REDACTED}]`);
  for (const pattern of KNOWN_SECRET_PATTERNS) text = text.replace(pattern, REDACTED);

  // Redact the whole credential part regardless of auth scheme. Limiting this
  // to Bearer/Basic leaves opaque Token, Digest, Negotiate, and custom schemes.
  text = text.replace(/^((?:Proxy-)?Authorization\s*:\s*).+$/gim, `$1${REDACTED}`);
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_:.-]{8,}/gi, `$1 ${REDACTED}`);
  text = text.replace(/^((?:Cookie|Set-Cookie)\s*:\s*).+$/gim, `$1${REDACTED}`);
  text = text.replace(/\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi, (match) => `${match.split("://")[0]}://${REDACTED}@`);
  text = text.replace(new RegExp(`([?&](?:${SENSITIVE_KEY})=)[^&#\\s]+`, "gi"), `$1${REDACTED}`);
  text = text.replace(
    new RegExp(`((?:["']?)\\b(?:${SENSITIVE_KEY})\\b(?:["']?)\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, "gi"),
    (_match, prefix: string, value: string) => `${prefix}${value[0]}${REDACTED}${value[0]}`,
  );
  text = text.replace(new RegExp(`((?:["']?)\\b(?:${SENSITIVE_KEY})\\b(?:["']?)\\s*[:=]\\s*)(?!["']|\\[REDACTED\\])([^\\s,;}{]+)`, "gi"), `$1${REDACTED}`);
  text = text.replace(
    /(--(?:api-key|token|password|secret|client-secret)\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi,
    (_match, prefix: string, value: string) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
      return `${prefix}${quote}${REDACTED}${quote}`;
    },
  );

  return text;
}

export function redactSensitiveText(input: string): string {
  return redactUnstructuredText(input);
}
