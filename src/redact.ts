export function redact(text: string): string {
  return text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|\d{6,12}:[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, match => /[A-Za-z]/.test(match) && /\d/.test(match) ? "[redacted]" : match)
    // key=value, key: value, and JSON/quoted keys ("password": "v", 'token': 'v', apiKey, Authorization: Bearer v);
    // a quoted value is masked whole, escaped quotes included.
    .replace(/((?:password|passwd|secret[_-]?key|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*(?:(?:Bearer|Basic|Token)\s+)?)(?:(["'])(?:\\.|(?!\2)[^\\\n])*\2|\S+)/gi,
      (_, key: string, quote?: string) => quote ? `${key}${quote}[redacted]${quote}` : `${key}[redacted]`)
    .replace(/\b(Bearer\s+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}=*/g, "$1[redacted]");
}

// Redacts text[start,end) as it appears in context, so a secret that starts inside the span but runs past its end still masks.
export function redactSpan(text: string, start: number, end: number): string {
  const narrow = redact(text.slice(start, end)), wide = redact(text.slice(start, end + 256));
  let same = 0;
  while (same < narrow.length && narrow[same] === wide[same]) same++;
  return same < narrow.length ? `${narrow.slice(0, same)}[redacted]` : narrow;
}
