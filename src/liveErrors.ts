/**
 * Custom error classes for live VibMath E2E runner.
 *
 * These carry structured context (HTTP status, action type, route, etc.)
 * so the outer catch can produce a detailed failure report without
 * scraping unstructured string messages.
 */

// ── HttpResponseError ────────────────────────────────────────────────────

export interface HttpResponseErrorContext {
  route: string;
  method: string;
  status: number;
  statusText: string;
  responseBody?: unknown;
  responseText?: string;
}

export class HttpResponseError extends Error {
  readonly context: HttpResponseErrorContext;

  constructor(context: HttpResponseErrorContext, options?: { cause?: unknown }) {
    const msg = `${context.method} ${context.route} failed: HTTP ${context.status}${context.responseText ? `: ${context.responseText.slice(0, 500)}` : ""}`;
    super(msg, options);
    this.name = "HttpResponseError";
    this.context = context;
  }
}

// ── LiveActionError ──────────────────────────────────────────────────────

export interface LiveActionErrorContext {
  type: string;
  principalId: string;
  organizationId?: string;
  projectId?: string;
  route: string;
  httpStatus?: number;
  responseBody?: unknown;
  responseText?: string;
}

export class LiveActionError extends Error {
  readonly context: LiveActionErrorContext;

  constructor(
    message: string,
    context: LiveActionErrorContext,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LiveActionError";
    this.context = context;
  }
}
