import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/auth'

/**
 * Route guard for the frontend.
 *
 * This is a redirect for humans, NOT the security boundary — it only checks
 * that a session cookie is present, never that it is valid. The gateway
 * verifies every /api/* call itself, which is what actually protects the
 * trading surface; a forged cookie gets past this middleware and straight
 * into a 401.
 *
 * /api/* is excluded so the proxied gateway responses (including its 401s)
 * reach the client untouched.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl
  const hasSession = req.cookies.has(SESSION_COOKIE)

  if (pathname === '/login') {
    if (!hasSession) return NextResponse.next()
    return NextResponse.redirect(new URL('/', req.url))
  }

  if (hasSession) return NextResponse.next()

  const login = new URL('/login', req.url)
  // Come back to where they were aiming once signed in
  if (pathname !== '/') login.searchParams.set('next', pathname + search)
  return NextResponse.redirect(login)
}

export const config = {
  // The login page loads public assets before there is a session, so static
  // files have to bypass the redirect. Extensions are listed rather than
  // matched as "anything with a dot": `.*\.[^/]+$` would also exempt any
  // future page route whose last segment happens to contain one, and that
  // exemption would be invisible at the point such a route is added.
  // glb/gltf earn their place the hard way: the whale model was being treated
  // as a page and bounced to /login, so an expired session handed GLTFLoader an
  // HTML login page and the pod view hung on "Loading the pod…".
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|svg|ico|webp|gif|avif|woff2?|glb|gltf)$).*)'],
}
