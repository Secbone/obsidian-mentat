import { requestUrl } from 'obsidian';

/** A fetch-compatible adapter backed by Obsidian's main-process `requestUrl`. */
export function obsidianFetch(
  input: string | Request | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? 'GET';
  const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
  const contentType = rawHeaders['Content-Type'] ?? rawHeaders['content-type'];
  const body = typeof init?.body === 'string' ? init.body : undefined;

  return requestUrl({
    url,
    method,
    contentType,
    body,
    headers: rawHeaders,
    throw: false,
  }).then((res) => {
    const text = res.text ?? '';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return new Response(stream, {
      status: res.status,
      headers: res.headers ? new Headers(res.headers) : undefined,
    });
  });
}
