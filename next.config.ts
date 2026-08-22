import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Spark ships untranspiled modern ESM, so it goes through the app's
  // transpile step. three does not need it - it publishes a build Next
  // consumes directly, and transpiling a library that size only costs
  // compile time.
  transpilePackages: ['@sparkjsdev/spark'],
};

export default nextConfig;
