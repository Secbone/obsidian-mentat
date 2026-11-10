export function redactDiagnostics(value: unknown, secrets: string[] = []): unknown {
  if (Array.isArray(value)) return value.map(item => redactDiagnostics(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /api.?key|authorization|password|secret|^(access|refresh|auth)[_-]?token$|^token$/i.test(key) ? '[REDACTED]' : redactDiagnostics(item, secrets)]));
  if (typeof value !== 'string') return value;
  if (/^(?:\{|\[)/.test(value.trim())) { try { return JSON.stringify(redactDiagnostics(JSON.parse(value), secrets)); } catch { /* plain text */ } }
  let text = value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]').replace(/([?&](?:api_key|access_token|token|key)=)[^&\s]+/gi, '$1[REDACTED]');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text;
}
