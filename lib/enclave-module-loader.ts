import { ModuleVerifier } from './verifier';
import * as fs from 'fs';

export interface SafeModuleRequirements {
  maxRequiredModules: string[];
  allowedCryptoUsage: 'none' | 'builtin-only';
  allowExternalAccess: boolean;
}

export class EnclaveModuleLoader {
  private verifier: ModuleVerifier;
  private requirements: SafeModuleRequirements;

  constructor(requirements: SafeModuleRequirements = {
    maxRequiredModules: ['crypto'],
    allowedCryptoUsage: 'builtin-only',
    allowExternalAccess: false
  }) {
    this.verifier = new ModuleVerifier();
    this.requirements = requirements;
  }

  /**
   * Safely load and validate a proprietary module
   * @param modulePath Path to the module file
   * @returns The loaded module if safe, throws if dangerous
   */
  loadModule(modulePath: string): any {
    console.log(`🔍 Validating proprietary module: ${modulePath}`);

    // Read module source
    const source = fs.readFileSync(modulePath, 'utf-8');

    // Analyze with enhanced verifier
    const analysis = this.verifier.analyzeModule(source);

    // Check requirements
    this.validateModule(analysis, modulePath);

    // If validation passes, load the module
    console.log(`✅ Module ${modulePath} passed validation, loading...`);
    return require(require.resolve(modulePath, { paths: [process.cwd()] }));
  }

  /**
   * Safely load and validate a proprietary module from URL
   * @param moduleUrl URL to fetch the module from
   * @returns The loaded module if safe, throws if dangerous
   */
  async loadModuleFromUrl(moduleUrl: string): Promise<any> {
    console.log(`🔍 Fetching and validating proprietary module: ${moduleUrl}`);

    try {
      // Fetch module source from URL
      const response = await fetch(moduleUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch module: HTTP ${response.status}`);
      }

      const source = await response.text();
      console.log(`📥 Fetched ${source.length} bytes from ${moduleUrl}`);

      // Analyze with enhanced verifier
      const analysis = this.verifier.analyzeModule(source);
      console.log(`🔍 Module analysis completed`);

      // Check requirements
      this.validateModule(analysis, moduleUrl);

      // If validation passes, create temporary file and load module
      console.log(`✅ Module ${moduleUrl} passed validation, loading...`);

      const tempPath = `/tmp/module-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.js`;
      fs.writeFileSync(tempPath, source);

      try {
        // Clear require cache to ensure fresh load
        delete require.cache[require.resolve(tempPath)];
        const loadedModule = require(tempPath);

        // Cleanup temp file
        fs.unlinkSync(tempPath);

        return loadedModule;
      } catch (loadError: any) {
        // Cleanup temp file on error
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
        throw new Error(`Failed to load module: ${loadError.message}`);
      }

    } catch (error: any) {
      console.error(`❌ Module loading failed: ${error.message}`);
      throw error;
    }
  }

  private validateModule(analysis: any, modulePath: string): void {
    const violations: string[] = [];

    // Check external access
    if (analysis.canAccessExternal && !this.requirements.allowExternalAccess) {
      violations.push(`Module can access external resources`);
    }

    // Check crypto usage
    if (analysis.cryptoUsage !== this.requirements.allowedCryptoUsage) {
      violations.push(`Crypto usage '${analysis.cryptoUsage}' not allowed (expected '${this.requirements.allowedCryptoUsage}')`);
    }

    // Check required modules
    const unauthorizedModules = analysis.requiredModules.filter(
      (mod: string) => !this.requirements.maxRequiredModules.includes(mod)
    );

    if (unauthorizedModules.length > 0) {
      violations.push(`Unauthorized modules: [${unauthorizedModules.join(', ')}]`);
    }

    // If any violations, reject the module
    if (violations.length > 0) {
      const error = new Error(
        `❌ REJECTED: Module ${modulePath} failed security validation:\n` +
        violations.map(v => `  - ${v}`).join('\n') +
        `\n\nModule analysis:\n` +
        `  Required modules: [${analysis.requiredModules.join(', ')}]\n` +
        `  Crypto usage: ${analysis.cryptoUsage}\n` +
        `  Can access external: ${analysis.canAccessExternal}`
      );
      error.name = 'ModuleSecurityViolation';
      throw error;
    }

    console.log(`✅ Module validation passed:`);
    console.log(`   Required modules: [${analysis.requiredModules.join(', ')}]`);
    console.log(`   Crypto usage: ${analysis.cryptoUsage}`);
    console.log(`   External access: ${analysis.canAccessExternal}`);
  }
}

// Example usage for tokscope-enclave integration:
export function loadTikTokAuthModule(modulePath: string) {
  const loader = new EnclaveModuleLoader({
    maxRequiredModules: ['crypto'],
    allowedCryptoUsage: 'builtin-only',
    allowExternalAccess: false // Crypto alone doesn't grant external access
  });

  return loader.loadModule(modulePath);
}