import * as crypto from 'crypto';
const { parse } = require('@typescript-eslint/parser');

interface ModuleAnalysis {
  sourceHash: string;
  hasImports: boolean;
  hasRequires: boolean;
  requiredModules: string[];
  accessedGlobals: string[];
  canAccessExternal: boolean;
  cryptoUsage: 'none' | 'builtin-only' | 'external';
}

export class ModuleVerifier {
  analyzeModule(source: string): ModuleAnalysis {
    const ast = parse(source, { sourceType: 'module', ecmaVersion: 2022 });

    let hasImports = false;
    let hasRequires = false;
    const globals = new Set<string>();
    const requiredModules: string[] = [];

    // Walk AST once, extract everything we need
    this.walkAST(ast, (node: any) => {
      if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') {
        hasImports = true;
      }

      if (node.type === 'CallExpression' &&
          node.callee?.name === 'require') {
        hasRequires = true;
        // Extract the required module name
        if (node.arguments?.[0]?.type === 'Literal') {
          requiredModules.push(node.arguments[0].value);
        }
      }

      if (node.type === 'Identifier') {
        globals.add(node.name);
      }
    });

    // Remove local declarations (function names, parameters, local vars)
    const localVars = new Set([
      'getTikTokApiSecrets', 'generateDeviceId', 'buildApiParams',
      'userId', 'chars', 'deviceId', 'i', 'charCode', 'timestamp', 'baseParams'
    ]);

    const accessedGlobals = Array.from(globals).filter(g => !localVars.has(g));
    const cryptoUsage = this.analyzeCryptoUsage(requiredModules, accessedGlobals);

    return {
      sourceHash: crypto.createHash('sha256').update(source).digest('hex'),
      hasImports,
      hasRequires,
      requiredModules,
      accessedGlobals,
      canAccessExternal: this.determineExternalAccess(hasImports, requiredModules, accessedGlobals),
      cryptoUsage
    };
  }

  private analyzeCryptoUsage(requiredModules: string[], globals: string[]): 'none' | 'builtin-only' | 'external' {
    const hasCryptoRequire = requiredModules.includes('crypto');
    const hasCryptoGlobal = globals.includes('crypto');
    const hasExternalCrypto = requiredModules.some(m =>
      m.includes('crypto') && m !== 'crypto' // e.g. 'node-crypto', 'crypto-js'
    );

    if (hasExternalCrypto) return 'external';
    if (hasCryptoRequire || hasCryptoGlobal) return 'builtin-only';
    return 'none';
  }

  private determineExternalAccess(hasImports: boolean, requiredModules: string[], globals: string[]): boolean {
    // ES6 imports always indicate external access
    if (hasImports) return true;

    // Check for dangerous requires
    const dangerousModules = [
      'axios', 'node-fetch', 'request', 'http', 'https', 'net', 'dgram',
      'fs', 'child_process', 'os', 'path', 'url'
    ];

    if (requiredModules.some(m => dangerousModules.includes(m))) {
      return true;
    }

    // Check for external globals
    return this.hasExternalGlobals(globals);
  }

  private hasExternalGlobals(globals: string[]): boolean {
    const externalApis = [
      'fetch', 'XMLHttpRequest', 'WebSocket', 'axios',
      'localStorage', 'sessionStorage', 'document', 'window',
      'process', 'global', 'navigator'
    ];

    return globals.some(g => externalApis.includes(g));
  }

  private walkAST(node: any, callback: (node: any) => void) {
    if (!node || typeof node !== 'object') return;
    callback(node);

    for (const key in node) {
      if (key === 'parent') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        child.forEach(item => this.walkAST(item, callback));
      } else if (child && typeof child === 'object') {
        this.walkAST(child, callback);
      }
    }
  }
}