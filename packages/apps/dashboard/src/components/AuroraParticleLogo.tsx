'use client'

import { useEffect, useRef } from 'react'
import {
  advanceParticleField,
  createParticleField,
  displaceByParticleField,
  moveParticleField,
} from '@/lib/particle-field'
import { Logo } from './Logo'

const LOGO_FIELD_OPTIONS = {
  maxRadius: 180,
  strength: 42,
}

const CANVAS_PADDING = 64

type LogoParticle = {
  x: number
  y: number
  radius: number
  color: string
  alpha: number
  phase: number
  glowAlpha: number
  glowScale: number
}

interface AuroraParticleLogoProps {
  compact?: boolean
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

function hash(x: number, y: number, salt = 0) {
  const value = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453
  return value - Math.floor(value)
}

function sampleRegion(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  bounds: { x: number; y: number; width: number; height: number },
  step: number,
  palette: string[],
  salt: number,
  glowAlpha: number,
  glowScale: number,
) {
  const particles: LogoParticle[] = []
  const pixels = context.getImageData(0, 0, width, height).data
  const left = Math.max(0, Math.floor(bounds.x))
  const top = Math.max(0, Math.floor(bounds.y))
  const right = Math.min(width, Math.ceil(bounds.x + bounds.width))
  const bottom = Math.min(height, Math.ceil(bounds.y + bounds.height))

  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      if (pixels[(y * width + x) * 4 + 3] < 112) continue
      const tone = hash(x, y, salt)
      const colorIndex = tone > 0.91 ? 2 : tone > 0.7 ? 1 : 0
      particles.push({
        x,
        y,
        radius: Math.max(0.62, step * (0.23 + hash(x, y, salt + 1) * 0.08)),
        color: palette[colorIndex] ?? palette[0],
        alpha: 0.8 + hash(x, y, salt + 2) * 0.2,
        phase: hash(x, y, salt + 3) * Math.PI * 2,
        glowAlpha,
        glowScale,
      })
    }
  }
  context.clearRect(0, 0, width, height)
  return particles
}

function drawSpacedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  letterSpacing: number,
) {
  let cursor = x
  for (const character of text) {
    context.fillText(character, cursor, y)
    cursor += context.measureText(character).width + letterSpacing
  }
}

export function AuroraParticleLogo({ compact = false, className = '', size = 'md' }: AuroraParticleLogoProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const sourceRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const markSize = size === 'lg' ? 60 : size === 'sm' ? 28 : 36

  useEffect(() => {
    const root = rootRef.current
    const source = sourceRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!root || !source || !canvas || !context) return

    let particles: LogoParticle[] = []
    let animationFrame = 0
    let width = 0
    let height = 0
    const startTime = performance.now()
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75)
    const logoField = createParticleField()

    const rebuild = () => {
      const rootBounds = root.getBoundingClientRect()
      width = Math.max(1, Math.ceil(rootBounds.width) + CANVAS_PADDING * 2)
      height = Math.max(1, Math.ceil(rootBounds.height) + CANVAS_PADDING * 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      canvas.style.left = `${-CANVAS_PADDING}px`
      canvas.style.top = `${-CANVAS_PADDING}px`

      const samplingCanvas = document.createElement('canvas')
      samplingCanvas.width = width
      samplingCanvas.height = height
      const samplingContext = samplingCanvas.getContext('2d', { willReadFrequently: true })
      const mark = source.querySelector<SVGSVGElement>('svg')
      const wordmark = source.querySelector<HTMLElement>('.aurora-logo-type')
      if (!samplingContext || !mark) return

      const markBounds = mark.getBoundingClientRect()
      const localMarkBounds = {
        x: markBounds.left - rootBounds.left + CANVAS_PADDING,
        y: markBounds.top - rootBounds.top + CANVAS_PADDING,
        width: markBounds.width,
        height: markBounds.height,
      }
      const viewBox = mark.viewBox.baseVal
      samplingContext.save()
      samplingContext.translate(localMarkBounds.x, localMarkBounds.y)
      samplingContext.scale(localMarkBounds.width / viewBox.width, localMarkBounds.height / viewBox.height)
      samplingContext.fillStyle = '#fff'
      mark.querySelectorAll('path').forEach(path => {
        const data = path.getAttribute('d')
        if (data) samplingContext.fill(new Path2D(data))
      })
      samplingContext.restore()

      const nextParticles = sampleRegion(
        samplingContext,
        width,
        height,
        localMarkBounds,
        2,
        ['#8152ff', '#a16dff', '#c3a4ff'],
        10,
        0.34,
        2.8,
      )

      if (wordmark && wordmark.offsetWidth > 0) {
        const wordBounds = wordmark.getBoundingClientRect()
        const localWordBounds = {
          x: wordBounds.left - rootBounds.left + CANVAS_PADDING,
          y: wordBounds.top - rootBounds.top + CANVAS_PADDING,
          width: wordBounds.width,
          height: wordBounds.height,
        }
        const style = window.getComputedStyle(wordmark)
        samplingContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        samplingContext.textBaseline = 'top'
        samplingContext.fillStyle = '#fff'
        drawSpacedText(
          samplingContext,
          wordmark.textContent ?? '',
          localWordBounds.x,
          localWordBounds.y,
          Number.parseFloat(style.letterSpacing) || 0,
        )
        nextParticles.push(...sampleRegion(
          samplingContext,
          width,
          height,
          localWordBounds,
          2,
          ['#ffffff', '#eee9ff', '#c2f3ff'],
          20,
          0.34,
          2.8,
        ))
      }
      particles = nextParticles
    }

    const draw = (now: number) => {
      const time = (now - startTime) / 1000
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, width, height)
      if (logoField.active && !reducedMotion) advanceParticleField(logoField, LOGO_FIELD_OPTIONS)
      context.globalCompositeOperation = 'lighter'

      for (const particle of particles) {
        const displaced = reducedMotion
          ? particle
          : displaceByParticleField(particle.x, particle.y, logoField, LOGO_FIELD_OPTIONS)
        const shimmer = reducedMotion ? 1 : 0.91 + Math.sin(time * 0.85 + particle.phase) * 0.09
        const x = displaced.x + (reducedMotion ? 0 : Math.sin(time * 0.48 + particle.phase) * 0.18)
        const y = displaced.y + (reducedMotion ? 0 : Math.cos(time * 0.42 + particle.phase) * 0.18)

        context.fillStyle = particle.color
        context.globalAlpha = particle.alpha * shimmer * particle.glowAlpha
        context.beginPath()
        context.arc(x, y, particle.radius * particle.glowScale, 0, Math.PI * 2)
        context.fill()
        context.globalAlpha = particle.alpha * shimmer
        context.beginPath()
        context.arc(x, y, particle.radius, 0, Math.PI * 2)
        context.fill()
      }
      context.globalAlpha = 1
      context.globalCompositeOperation = 'source-over'
      animationFrame = requestAnimationFrame(draw)
    }

    const onPointerMove = (event: PointerEvent) => {
      const bounds = root.getBoundingClientRect()
      const pointerX = event.clientX - bounds.left + CANVAS_PADDING
      const pointerY = event.clientY - bounds.top + CANVAS_PADDING
      if (!logoField.active) {
        const activationRadiusSquared = 34 ** 2
        let nearbyParticles = 0
        for (const particle of particles) {
          const deltaX = particle.x - pointerX
          const deltaY = particle.y - pointerY
          if (deltaX * deltaX + deltaY * deltaY > activationRadiusSquared) continue
          nearbyParticles += 1
          if (nearbyParticles >= 8) break
        }
        if (nearbyParticles < 8) return
      }
      moveParticleField(logoField, pointerX, pointerY)
    }

    const resizeObserver = new ResizeObserver(rebuild)
    resizeObserver.observe(root)
    rebuild()
    void document.fonts.ready.then(rebuild)
    animationFrame = requestAnimationFrame(draw)
    window.addEventListener('pointermove', onPointerMove)

    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
    }
  }, [])

  return (
    <div ref={rootRef} className={`aurora-logo aurora-logo-${size} aurora-logo-particle ${className}`} aria-label="OpenWhale">
      <div ref={sourceRef} className="aurora-particle-logo-source" aria-hidden="true">
        <span className="aurora-logo-pixel"><Logo size={markSize} /></span>
        {!compact && <span className="aurora-logo-type">OpenWhale</span>}
      </div>
      <canvas ref={canvasRef} className="aurora-particle-logo-canvas" aria-hidden="true" />
    </div>
  )
}
