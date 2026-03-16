// lib/log.js — Structured logging for holodeck error monitor (CommonJS)
function format(level, component, event, data) {
  const pairs = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v : String(v)}`)
    .join(' ');
  return `[${level.padEnd(5)}] [${component}] ${event}${pairs ? ' | ' + pairs : ''}`;
}

// All levels write to stdout — Phala Cloud's CVM log collector only captures stdout.
// HoloClaw error monitor pattern-matches on [FAIL] and [ERROR] tags regardless of stream.
const log = {
  ok:    (component, event, data = {}) => console.log(format('OK', component, event, data)),
  fail:  (component, event, data = {}) => console.log(format('FAIL', component, event, data)),
  warn:  (component, event, data = {}) => console.log(format('WARN', component, event, data)),
  error: (component, event, data = {}) => console.log(format('ERROR', component, event, data)),
};

module.exports = { log };
