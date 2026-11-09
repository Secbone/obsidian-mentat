export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('已停止生成', 'AbortError');
}

/** Stop waiting promptly; the owner must also pass the signal to the operation. */
export async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) void operation.catch(() => undefined);
  throwIfAborted(signal);
  if (!signal) return operation;
  let onAbort: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => { try { throwIfAborted(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function errorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const extra = error as Error & { code?: string; status?: number };
  return {
    name: error.name, message: error.message, code: extra.code, status: extra.status,
    stack: error.stack,
    cause: error.cause === undefined ? undefined : String(error.cause),
  };
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_NETWORK_CHANGED/i.test(message)
    ? '请求期间网络环境发生变化，请等待网络稳定后继续。'
    : /network error|failed to fetch|connection error/i.test(message)
      ? `模型连接中断，请检查网络后继续。原始错误：${message}`
      : message;
}
