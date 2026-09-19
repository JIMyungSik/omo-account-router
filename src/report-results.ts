export const REPORT_RESULTS = [
  "SUCCESS",
  "AUTH_EXPIRED",
  "AUTH_REVOKED",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "NETWORK_ERROR",
  "SERVER_ERROR",
  "BAD_REQUEST",
  "INVALID_ARGUMENT",
  "MODEL_NOT_FOUND",
  "PROMPT_ERROR",
  "TOOL_ERROR",
  "LOCAL_ERROR",
  "UNKNOWN",
] as const;

export type ReportResult = (typeof REPORT_RESULTS)[number];

const REPORT_RESULT_SET = new Set<string>(REPORT_RESULTS);

export function isReportResult(value: string): value is ReportResult {
  return REPORT_RESULT_SET.has(value);
}

export function parseReportResult(value: string): ReportResult {
  if (!isReportResult(value)) {
    throw new Error(
      `invalid report result: ${value}\n` +
        `expected one of: ${REPORT_RESULTS.join(", ")}`,
    );
  }
  return value;
}
