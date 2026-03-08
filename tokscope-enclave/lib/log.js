// lib/log.js — Structured logging for holodeck error monitor (CommonJS)
function format(level, component, event, data) {
  const pairs = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v : String(v)}`)
    .join(' ');
  return `[${level.padEnd(5)}] [${component}] ${event}${pairs ? ' | ' + pairs : ''}`;
}

const log = {
  ok:    (component, event, data = {}) => console.log(format('OK', component, event, data)),
  fail:  (component, event, data = {}) => console.error(format('FAIL', component, event, data)),
  warn:  (component, event, data = {}) => console.warn(format('WARN', component, event, data)),
  error: (component, event, data = {}) => console.error(format('ERROR', component, event, data)),
};

module.exports = { log };
