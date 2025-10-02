import { SocksProxyAgent } from 'socks-proxy-agent';
import axios, { AxiosRequestConfig } from 'axios';

export interface ProxyConfig {
  socksProxy?: string;
  httpsProxy?: string;
}

/**
 * Get proxy configuration from environment variables
 */
export function getProxyConfig(): ProxyConfig {
  return {
    socksProxy: process.env.SOCKS_PROXY,
    httpsProxy: process.env.HTTPS_PROXY
  };
}

/**
 * Create HTTP agent for SOCKS proxy
 */
export function createProxyAgent(proxyUrl: string) {
  if (proxyUrl.startsWith('socks://') || proxyUrl.startsWith('socks5://')) {
    return new SocksProxyAgent(proxyUrl);
  }
  // For HTTP/HTTPS proxies, use built-in Node.js support
  return proxyUrl;
}

/**
 * Configure axios instance with proxy support
 */
export function configureAxiosProxy(config: AxiosRequestConfig = {}): AxiosRequestConfig {
  const proxyConfig = getProxyConfig();

  if (proxyConfig.socksProxy) {
    const agent = createProxyAgent(`socks5://${proxyConfig.socksProxy}`);
    config.httpsAgent = agent;
    config.httpAgent = agent;
    console.log(`🌐 Using SOCKS5 proxy: ${proxyConfig.socksProxy}`);
  } else if (proxyConfig.httpsProxy) {
    config.proxy = false; // Disable axios built-in proxy
    config.httpsAgent = createProxyAgent(proxyConfig.httpsProxy);
    config.httpAgent = createProxyAgent(proxyConfig.httpsProxy);
    console.log(`🌐 Using HTTPS proxy: ${proxyConfig.httpsProxy}`);
  }

  return config;
}

/**
 * Create axios instance with proxy configuration
 */
export function createAxiosWithProxy(baseConfig: AxiosRequestConfig = {}) {
  const config = configureAxiosProxy(baseConfig);
  return axios.create(config);
}

/**
 * Configure global fetch with proxy support (limited in Node.js)
 */
export function configureFetchProxy() {
  // Note: Built-in Node.js fetch has limited proxy support
  // All main API clients use axios which properly supports SOCKS proxies
  console.log('ℹ️  Fetch proxy support is limited. API clients use axios with full SOCKS proxy support.');
}

/**
 * Initialize proxy configuration for all HTTP clients
 */
export function initializeProxy() {
  configureFetchProxy();

  // Configure default axios instance
  const proxyConfig = getProxyConfig();
  if (proxyConfig.socksProxy || proxyConfig.httpsProxy) {
    const config = configureAxiosProxy();
    Object.assign(axios.defaults, config);
  }
}