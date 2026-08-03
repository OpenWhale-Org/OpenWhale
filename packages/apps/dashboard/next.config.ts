import type { NextConfig } from 'next'

const GATEWAY_URL = process.env['OPENWHALE_GATEWAY_URL'] ?? 'http://localhost:3001'

/**
 * Pure-frontend Next app. The runtime lives in @openwhaleorg/gateway; every
 * /api/* request (fetch AND EventSource) proxies there, so client code is
 * origin-agnostic and unchanged from the embedded era.
 */
const nextConfig: NextConfig = {
  // A deploy build must not share .next with the dev server: `next dev` rewrites
  // that directory in place, so a production bundle built there is silently
  // clobbered (no BUILD_ID left) the moment dev touches it again. deploy.sh
  // builds with NEXT_DIST_DIR=.next-deploy and ships that instead.
  distDir: process.env['NEXT_DIST_DIR'] ?? '.next',
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${GATEWAY_URL}/api/:path*` }]
  },
}

export default nextConfig
