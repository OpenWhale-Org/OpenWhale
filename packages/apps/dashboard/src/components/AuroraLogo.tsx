import { Logo } from './Logo'
import { AuroraParticleLogo } from './AuroraParticleLogo'

interface AuroraLogoProps {
  compact?: boolean
  className?: string
  particle?: boolean
  size?: 'sm' | 'md' | 'lg'
}

/** Aurora wordmark using OpenWhale's original pixel-whale brand mark. */
export function AuroraLogo({ compact = false, className = '', particle = false, size = 'md' }: AuroraLogoProps) {
  const markSize = size === 'lg' ? 60 : size === 'sm' ? 28 : 36

  if (particle) {
    return <AuroraParticleLogo compact={compact} className={className} size={size} />
  }

  return (
    <div className={`aurora-logo aurora-logo-${size} ${className}`} aria-label="OpenWhale">
      <span className="aurora-logo-pixel" aria-hidden="true"><Logo size={markSize} /></span>
      {!compact && (
        <span className="aurora-logo-type" aria-hidden="true">OpenWhale</span>
      )}
    </div>
  )
}
