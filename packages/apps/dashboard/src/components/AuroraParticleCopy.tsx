'use client'

import { useEffect, useRef } from 'react'
import {
  advanceParticleField,
  createParticleField,
  displaceByParticleField,
  moveParticleField,
} from '@/lib/particle-field'

const TEXT_FIELD_OPTIONS = {
  maxRadius: 180,
  strength: 42,
}

type CopyParticle = {
  x: number
  y: number
  radius: number
  color: string
  alpha: number
  phase: number
}

type TextStyle = {
  font: string
  letterSpacing: number
  lineHeight: number
}

function hash(x: number, y: number, salt = 0) {
  const value = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453
  return value - Math.floor(value)
}

function readStyle(element: HTMLElement): TextStyle {
  const style = window.getComputedStyle(element)
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const fontSize = Number.parseFloat(style.fontSize)
  return {
    font,
    letterSpacing: Number.parseFloat(style.letterSpacing) || 0,
    lineHeight: Number.parseFloat(style.lineHeight) || fontSize * 1.2,
  }
}

function measureSpacedText(context: CanvasRenderingContext2D, text: string, letterSpacing: number) {
  let width = 0
  for (let index = 0; index < text.length; index += 1) {
    width += context.measureText(text[index]).width
    if (index < text.length - 1) width += letterSpacing
  }
  return width
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

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number, letterSpacing: number) {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (line && measureSpacedText(context, candidate, letterSpacing) > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

function sampleRegion(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  bounds: { x: number; y: number; width: number; height: number },
  step: number,
  palette: string[],
  alpha: number,
  salt: number,
) {
  const particles: CopyParticle[] = []
  const left = Math.max(0, Math.floor(bounds.x))
  const top = Math.max(0, Math.floor(bounds.y))
  const right = Math.min(width, Math.ceil(bounds.x + bounds.width))
  const bottom = Math.min(height, Math.ceil(bounds.y + bounds.height))
  const pixels = context.getImageData(0, 0, width, height).data

  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      if (pixels[(y * width + x) * 4 + 3] < 112) continue
      const tone = hash(x, y, salt)
      const colorIndex = tone > 0.91 ? 2 : tone > 0.73 ? 1 : 0
      particles.push({
        x,
        y,
        radius: Math.max(0.62, step * (0.23 + hash(x, y, salt + 1) * 0.08)),
        color: palette[colorIndex] ?? palette[0],
        alpha: alpha * (0.78 + hash(x, y, salt + 2) * 0.22),
        phase: hash(x, y, salt + 3) * Math.PI * 2,
      })
    }
  }
  context.clearRect(0, 0, width, height)
  return particles
}

export function AuroraParticleCopy() {
  const rootRef = useRef<HTMLDivElement>(null)
  const sourceRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const root = rootRef.current
    const source = sourceRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!root || !source || !canvas || !context) return

    let particles: CopyParticle[] = []
    let animationFrame = 0
    let width = 0
    let height = 0
    const startTime = performance.now()
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75)
    const textField = createParticleField()

    const rebuild = () => {
      const rootBounds = root.getBoundingClientRect()
      width = Math.max(1, Math.round(rootBounds.width))
      height = Math.max(1, Math.round(rootBounds.height))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`

      const samplingCanvas = document.createElement('canvas')
      samplingCanvas.width = width
      samplingCanvas.height = height
      const samplingContext = samplingCanvas.getContext('2d', { willReadFrequently: true })
      if (!samplingContext) return
      samplingContext.textBaseline = 'top'
      samplingContext.fillStyle = '#fff'

      const toLocalBounds = (element: HTMLElement) => {
        const bounds = element.getBoundingClientRect()
        return {
          x: bounds.left - rootBounds.left,
          y: bounds.top - rootBounds.top,
          width: bounds.width,
          height: bounds.height,
        }
      }

      const kicker = source.querySelector<HTMLElement>('[data-particle-kicker]')
      const headingLines = Array.from(source.querySelectorAll<HTMLElement>('[data-particle-heading]'))
      const description = source.querySelector<HTMLElement>('[data-particle-description]')
      const nextParticles: CopyParticle[] = []

      if (kicker) {
        const bounds = toLocalBounds(kicker)
        const style = readStyle(kicker)
        samplingContext.font = style.font
        drawSpacedText(samplingContext, kicker.textContent ?? '', bounds.x, bounds.y, style.letterSpacing)
        nextParticles.push(...sampleRegion(samplingContext, width, height, bounds, 2, ['#d2c2ff', '#a78fff', '#83e6ff'], 1, 10))
      }

      headingLines.forEach((line, index) => {
        const bounds = toLocalBounds(line)
        const style = readStyle(line)
        samplingContext.font = style.font
        drawSpacedText(samplingContext, line.textContent ?? '', bounds.x, bounds.y, style.letterSpacing)
        nextParticles.push(...sampleRegion(samplingContext, width, height, bounds, 4, ['#ffffff', '#d2c4ff', '#92e7ff'], 1, 20 + index))
      })

      if (description) {
        const bounds = toLocalBounds(description)
        const style = readStyle(description)
        samplingContext.font = style.font
        const lines = wrapText(samplingContext, description.textContent ?? '', bounds.width, style.letterSpacing)
        lines.forEach((line, index) => {
          drawSpacedText(samplingContext, line, bounds.x, bounds.y + index * style.lineHeight, style.letterSpacing)
        })
        nextParticles.push(...sampleRegion(samplingContext, width, height, bounds, 2, ['#f1edff', '#cbbdf2', '#91def5'], 0.92, 30))
      }
      particles = nextParticles
    }

    const draw = (now: number) => {
      const time = (now - startTime) / 1000
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, width, height)
      if (textField.active && !reducedMotion) advanceParticleField(textField, TEXT_FIELD_OPTIONS)
      context.globalCompositeOperation = 'lighter'

      for (const particle of particles) {
        const displaced = reducedMotion
          ? particle
          : displaceByParticleField(particle.x, particle.y, textField, TEXT_FIELD_OPTIONS)
        const shimmer = reducedMotion ? 1 : 0.91 + Math.sin(time * 0.85 + particle.phase) * 0.09
        const x = displaced.x + (reducedMotion ? 0 : Math.sin(time * 0.48 + particle.phase) * 0.18)
        const y = displaced.y + (reducedMotion ? 0 : Math.cos(time * 0.42 + particle.phase) * 0.18)

        context.fillStyle = particle.color
        context.globalAlpha = particle.alpha * shimmer * 0.24
        context.beginPath()
        context.arc(x, y, particle.radius * 2.5, 0, Math.PI * 2)
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
      const pointerX = event.clientX - bounds.left
      const pointerY = event.clientY - bounds.top
      if (!textField.active) {
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
      moveParticleField(textField, pointerX, pointerY)
    }
    // Same reason as AuroraBackground: this dashboard lives in a tab for days,
    // so stop drawing when it is hidden instead of trusting rAF throttling.
    const onVisibility = () => {
      cancelAnimationFrame(animationFrame)
      if (!document.hidden) animationFrame = requestAnimationFrame(draw)
    }
    const resizeObserver = new ResizeObserver(rebuild)
    resizeObserver.observe(root)
    rebuild()
    animationFrame = requestAnimationFrame(draw)
    window.addEventListener('pointermove', onPointerMove)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <div ref={rootRef} className="aurora-login-copy aurora-particle-copy">
      <div ref={sourceRef} className="aurora-particle-copy-source">
        <span className="aurora-login-kicker" data-particle-kicker>AI TRADING INFRASTRUCTURE</span>
        <h1>
          <span data-particle-heading>Trade deeper.</span>
          <span data-particle-heading>Move smarter.</span>
        </h1>
        <p data-particle-description>Build, observe and operate intelligent strategies from one calm, connected workspace.</p>
      </div>
      <canvas ref={canvasRef} className="aurora-particle-copy-canvas" aria-hidden="true" />
    </div>
  )
}
