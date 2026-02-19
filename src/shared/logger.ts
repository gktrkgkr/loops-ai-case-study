/**
 * Structured logger for GCP Cloud Logging.
 *
 * Cloud Logging automatically parses JSON written to stdout/stderr.
 * By emitting structured JSON instead of plain strings, logs become
 * filterable by severity, eventId, conversationId, handler, etc.
 *
 * @see https://cloud.google.com/functions/docs/monitoring/logging#writing_structured_logs
 */

type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

interface LogEntry {
  severity: Severity;
  message: string;
  handler?: string;
  eventId?: string;
  conversationId?: string;
  messageId?: string;
  [key: string]: unknown;
}

function write(entry: LogEntry): void {
  const output = JSON.stringify({
    ...entry,
    timestamp: new Date().toISOString(),
  });

  if (entry.severity === 'ERROR') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

export const log = {
  info(message: string, context?: Omit<LogEntry, 'severity' | 'message'>): void {
    write({ severity: 'INFO', message, ...context });
  },

  warn(message: string, context?: Omit<LogEntry, 'severity' | 'message'>): void {
    write({ severity: 'WARNING', message, ...context });
  },

  error(message: string, context?: Omit<LogEntry, 'severity' | 'message'>): void {
    write({ severity: 'ERROR', message, ...context });
  },

  debug(message: string, context?: Omit<LogEntry, 'severity' | 'message'>): void {
    write({ severity: 'DEBUG', message, ...context });
  },
};
