import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Spark + three ship untranspiled modern ESM; keep them in the app's
  // transpile set so the Next server bundler handles them consistently.
  transpilePackages: ['@sparkjsdev/spark', 'three'],
};

export default nextConfig;
