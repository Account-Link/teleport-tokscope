// lib/log.ts — Structured logging for holodeck error monitor
function format(level: string, component: string, event: string, data: Record<string, unknown>) {
  const pairs = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v : String(v)}`)
    .join(' ');
  return `[${level.padEnd(5)}] [${component}] ${event}${pairs ? ' | ' + pairs : ''}`;
}

export const log = {
  ok:    (component: string, event: string, data: Record<string, unknown> = {}) => console.log(format('OK', component, event, data)),
  fail:  (component: string, event: string, data: Record<string, unknown> = {}) => console.error(format('FAIL', component, event, data)),
  warn:  (component: string, event: string, data: Record<string, unknown> = {}) => console.warn(format('WARN', component, event, data)),
  error: (component: string, event: string, data: Record<string, unknown> = {}) => console.error(format('ERROR', component, event, data)),
};
