import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native/runtime-heavy packages stay external to the server bundle.
  serverExternalPackages: ['better-sqlite3', 'pg'],
  webpack: (config) => {
    // The pipeline core (src/) uses NodeNext-style `.js` import specifiers for
    // TypeScript files; teach webpack the same substitution TS does.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
