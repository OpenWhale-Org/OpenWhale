import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@openwhale/core'],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Native modules and Node-only packages that must not be bundled
      const serverExternals = [
        'better-sqlite3',
        'esbuild',
        'ioredis',
        'pino',
        'pino-pretty',
      ]
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        ...serverExternals,
      ]
    }
    return config
  },
}

export default nextConfig
