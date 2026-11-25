/**
 * Error text that can reach a log, the history table or the screen. Every source error passes
 * through `errorMessage`, which masks anything shaped like a credential: the password in a DSN,
 * a token in a query string, a bearer header. Source implementations already avoid putting
 * secrets in messages; this is the second line of defense.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sanitizeMessage(msg: string): string {
  return msg
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):[^@/\s]+@/gi, "$1$2:***@")
    .replace(/([?&;](?:token|api_key|apikey|key|password|pwd|secret)=)[^&\s;'"]+/gi, "$1***")
    .replace(/\b(bearer\s+)[a-z0-9._~+/-]+=*/gi, "$1***")
    .replace(/\b(password|pwd|secret)\s*[:=]\s*[^\s&;]+/gi, "$1=***");
}

export function errorMessage(e: unknown): string {
  return sanitizeMessage(e instanceof Error ? e.message : String(e));
}
