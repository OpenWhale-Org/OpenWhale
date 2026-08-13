'use client'

import { useEffect, useRef } from 'react'

const MASTER_SRC = '/market-whale-master.png'
const FALLBACK_MASTER_WIDTH = 1672
const FALLBACK_MASTER_HEIGHT = 941
const WHALE_BOUNDS = { x: 122, y: 118, width: 1348, height: 654 }
const EXCLUDED_DETAILS = [
  { x: 560, y: 812, radius: 116 },
  { x: 854, y: 812, radius: 116 },
  { x: 1160, y: 812, radius: 116 },
]
const POINTER_RADIUS = 250

const DATA_CALLOUTS = [
  { value: '89,742.61', change: '+1.28%', x: 965, y: 98, anchorX: 1038, anchorY: 133 },
  { value: '23,605.13', change: '+0.94%', x: 1260, y: 314, anchorX: 1178, anchorY: 342 },
  { value: '57,938.27', change: '+1.18%', x: 1250, y: 526, anchorX: 1168, anchorY: 447 },
  { value: '12,389.45', change: '+0.33%', x: 660, y: 648, anchorX: 735, anchorY: 640 },
]

const DOT_GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '010', '010', '111'],
  '2': ['111', '001', '001', '111', '100', '100', '111'],
  '3': ['111', '001', '001', '111', '001', '001', '111'],
  '4': ['101', '101', '101', '111', '001', '001', '001'],
  '5': ['111', '100', '100', '111', '001', '001', '111'],
  '6': ['111', '100', '100', '111', '101', '101', '111'],
  '7': ['111', '001', '001', '010', '010', '010', '010'],
  '8': ['111', '101', '101', '111', '101', '101', '111'],
  '9': ['111', '101', '101', '111', '001', '001', '111'],
  '+': ['000', '010', '010', '111', '010', '010', '000'],
  '%': ['101', '001', '010', '010', '010', '100', '101'],
  ',': ['0', '0', '0', '0', '0', '1', '1'],
  '.': ['0', '0', '0', '0', '0', '0', '1'],
}

type Particle = {
  x: number
  y: number
  radius: number
  color: string
  alpha: number
  phase: number
  speed: number
  driftX: number
  driftY: number
  edge: boolean
}

type Sample = {
  red: number
  green: number
  blue: number
  brightness: number
  active: boolean
}

type PointerState = {
  x: number
  y: number
  targetX: number
  targetY: number
  influence: number
  targetInfluence: number
}

function hash(x: number, y: number, salt = 0) {
  const value = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453
  return value - Math.floor(value)
}

function isExcluded(x: number, y: number) {
  if (y > 775) return true
  if (DATA_CALLOUTS.some(callout => x >= callout.x - 5 && x <= callout.x + 98 && y >= callout.y - 5 && y <= callout.y + 32)) return true
  return EXCLUDED_DETAILS.some(detail => Math.hypot(x - detail.x, y - detail.y) < detail.radius)
}

function displaceByPointer(x: number, y: number, pointer: PointerState, strength: number, radius = POINTER_RADIUS) {
  if (pointer.influence <= 0.002) return { x, y }
  const dx = x - pointer.x
  const dy = y - pointer.y
  const distance = Math.hypot(dx, dy) || 1
  if (distance >= radius) return { x, y }

  const force = (1 - distance / radius) ** 1.65 * strength * pointer.influence
  const radialX = dx / distance
  const radialY = dy / distance
  const tangentX = -radialY
  const tangentY = radialX
  return {
    x: x + radialX * force * 0.88 + tangentX * force * 0.42,
    y: y + radialY * force * 0.88 + tangentY * force * 0.42,
  }
}

function drawDotText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  unit: number,
  color: string,
  alpha: number,
  pointer: PointerState,
  reducedMotion: boolean,
) {
  let cursor = x
  context.beginPath()
  for (const character of text) {
    const glyph = DOT_GLYPHS[character]
    if (!glyph) {
      cursor += unit * 2
      continue
    }
    const width = glyph[0].length
    glyph.forEach((row, rowIndex) => {
      for (let column = 0; column < row.length; column += 1) {
        if (row[column] !== '1') continue
        const baseX = cursor + column * unit
        const baseY = y + rowIndex * unit
        const point = reducedMotion ? { x: baseX, y: baseY } : displaceByPointer(baseX, baseY, pointer, 28, POINTER_RADIUS * 1.08)
        context.moveTo(point.x + unit * 0.25, point.y)
        context.arc(point.x, point.y, Math.max(0.62, unit * 0.29), 0, Math.PI * 2)
      }
    })
    cursor += (width + 1) * unit
  }
  context.fillStyle = color
  context.globalAlpha = alpha
  context.fill()
}

function drawDataCallouts(
  context: CanvasRenderingContext2D,
  scale: number,
  offsetX: number,
  offsetY: number,
  time: number,
  pointer: PointerState,
  reducedMotion: boolean,
) {
  const unit = Math.max(1.85, scale * 3.55)
  for (let index = 0; index < DATA_CALLOUTS.length; index += 1) {
    const callout = DATA_CALLOUTS[index]
    const x = offsetX + callout.x * scale
    const y = offsetY + callout.y * scale
    const anchorX = offsetX + callout.anchorX * scale
    const anchorY = offsetY + callout.anchorY * scale
    const pulse = 0.82 + Math.sin(time * 1.15 + index * 1.7) * 0.12

    context.globalAlpha = 0.58 * pulse
    context.strokeStyle = '#607cff'
    context.lineWidth = 0.8
    context.setLineDash([2.5, 4])
    context.beginPath()
    context.moveTo(anchorX, anchorY)
    context.lineTo(x - 8, y + unit * 3)
    context.lineTo(x + 54, y + unit * 3)
    context.stroke()
    context.setLineDash([])

    context.globalAlpha = 0.13 * pulse
    context.fillStyle = '#70d9ff'
    context.beginPath()
    context.arc(anchorX, anchorY, 5.2, 0, Math.PI * 2)
    context.fill()
    context.globalAlpha = 0.9
    context.fillStyle = '#73e3ff'
    context.beginPath()
    context.arc(anchorX, anchorY, 1.35, 0, Math.PI * 2)
    context.fill()

    context.save()
    context.shadowBlur = 5
    context.shadowColor = 'rgba(91, 183, 255, .5)'
    drawDotText(context, callout.value, x, y, unit, '#83e3ff', 0.96 * pulse, pointer, reducedMotion)
    context.shadowColor = 'rgba(168, 116, 255, .45)'
    drawDotText(context, callout.change, x, y + unit * 9, unit * 0.84, '#bd91ff', 0.88 * pulse, pointer, reducedMotion)
    context.restore()
  }
  context.globalAlpha = 1
}

function pixelAt(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): Sample {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return { red: 0, green: 0, blue: 0, brightness: 0, active: false }
  }
  const offset = (y * width + x) * 4
  const red = data[offset]
  const green = data[offset + 1]
  const blue = data[offset + 2]
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue)
  const brightness = Math.max(red * 0.3 + green * 0.56 + blue * 0.14, blue * 0.86) / 255
  const active = brightness > 0.105 && (blue > red * 1.05 || chroma > 20)
  return { red, green, blue, brightness, active }
}

function isEdgePixel(data: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const distance = 5
  const neighbors = [
    pixelAt(data, width, height, x - distance, y),
    pixelAt(data, width, height, x + distance, y),
    pixelAt(data, width, height, x, y - distance),
    pixelAt(data, width, height, x, y + distance),
    pixelAt(data, width, height, x - distance, y - distance),
    pixelAt(data, width, height, x + distance, y + distance),
  ]
  return neighbors.filter(pixel => !pixel.active).length >= 2
}

function buildParticles(image: HTMLImageElement) {
  const sourceWidth = image.naturalWidth || FALLBACK_MASTER_WIDTH
  const sourceHeight = image.naturalHeight || FALLBACK_MASTER_HEIGHT
  const offscreen = document.createElement('canvas')
  offscreen.width = sourceWidth
  offscreen.height = sourceHeight
  const context = offscreen.getContext('2d', { willReadFrequently: true })
  if (!context) return []
  context.drawImage(image, 0, 0, sourceWidth, sourceHeight)
  const data = context.getImageData(0, 0, sourceWidth, sourceHeight).data
  const particles: Particle[] = []
  const step = 3

  for (let y = WHALE_BOUNDS.y; y <= WHALE_BOUNDS.y + WHALE_BOUNDS.height; y += step) {
    for (let x = WHALE_BOUNDS.x; x <= WHALE_BOUNDS.x + WHALE_BOUNDS.width; x += step) {
      if (isExcluded(x, y)) continue
      const sample = pixelAt(data, sourceWidth, sourceHeight, x, y)
      if (!sample.active) continue

      // Sparse source pixels need a small halo, but treating every isolated line as
      // an edge produces blobs. Reserve the halo for genuinely bright source nodes.
      const edge = sample.brightness > 0.62 && isEdgePixel(data, sourceWidth, sourceHeight, x, y)
      const keepChance = edge ? 0.99 : Math.min(0.98, 0.38 + sample.brightness * 1.28)
      if (hash(x, y, 1) > keepChance) continue

      const boost = edge ? 1.28 : 1.22
      const red = Math.min(255, Math.round(sample.red * boost + (edge ? 18 : 4)))
      const green = Math.min(255, Math.round(sample.green * boost + (edge ? 12 : 2)))
      const blue = Math.min(255, Math.round(sample.blue * boost + 14))
      particles.push({
        x,
        y,
        radius: edge ? 1.05 + hash(x, y, 4) * 0.55 : 0.68 + hash(x, y, 4) * 0.62,
        color: `${red},${green},${blue}`,
        alpha: edge ? 0.9 + sample.brightness * 0.1 : 0.5 + sample.brightness * 0.5,
        phase: hash(x, y, 5) * Math.PI * 2,
        speed: 0.42 + hash(x, y, 6) * 0.55,
        driftX: (hash(x, y, 7) - 0.5) * (edge ? 0.18 : 0.34),
        driftY: (hash(x, y, 8) - 0.5) * (edge ? 0.18 : 0.34),
        edge,
      })
    }
  }
  return particles
}

function buildFallbackParticles() {
  const particles: Particle[] = []
  const paths = [
    [[145, 438], [190, 447], [235, 481], [283, 535], [330, 557], [370, 570], [330, 581], [278, 619], [228, 684], [183, 735], [145, 758]],
    [[370, 570], [440, 557], [535, 519], [650, 442], [790, 334], [940, 232], [1080, 176], [1220, 143], [1360, 136], [1450, 151]],
    [[1450, 151], [1428, 210], [1365, 270], [1238, 377], [1090, 490], [930, 578], [760, 632], [600, 648], [475, 621], [401, 596]],
    [[985, 390], [947, 465], [900, 570], [844, 666], [796, 709], [865, 691], [933, 625], [990, 535], [1046, 421]],
    [[1090, 371], [1082, 465], [1073, 634], [1128, 574], [1155, 490], [1162, 445]],
  ]

  paths.forEach((path, pathIndex) => {
    for (let segment = 1; segment < path.length; segment += 1) {
      const [startX, startY] = path[segment - 1]
      const [endX, endY] = path[segment]
      const length = Math.hypot(endX - startX, endY - startY)
      const count = Math.max(2, Math.ceil(length / 4))
      for (let index = 0; index < count; index += 1) {
        const amount = index / count
        const x = startX + (endX - startX) * amount
        const y = startY + (endY - startY) * amount
        particles.push({
          x, y,
          radius: 1.25,
          color: pathIndex % 2 === 0 ? '174,138,255' : '100,132,255',
          alpha: 0.84,
          phase: hash(x, y, pathIndex) * Math.PI * 2,
          speed: 0.65 + hash(x, y, pathIndex + 1) * 0.6,
          driftX: 0.16,
          driftY: 0.16,
          edge: true,
        })
      }
    }
  })
  return particles
}

export function AuroraBackground() {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pointerRef = useRef({ x: -9999, y: -9999, targetX: -9999, targetY: -9999, influence: 0, targetInfluence: 0 })

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!root || !canvas || !context) return

    let particles: Particle[] = buildFallbackParticles()
    let animationFrame = 0
    let width = 0
    let height = 0
    let scale = 1
    let offsetX = 0
    let offsetY = 0
    let startTime = performance.now()
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75)

    const layout = () => {
      width = root.clientWidth
      height = root.clientHeight
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      scale = Math.min(width * 1.03 / WHALE_BOUNDS.width, height * 0.8 / WHALE_BOUNDS.height)
      offsetX = width * 0.505 - (WHALE_BOUNDS.x + WHALE_BOUNDS.width * 0.5) * scale
      offsetY = height * 0.51 - (WHALE_BOUNDS.y + WHALE_BOUNDS.height * 0.5) * scale
    }

    const draw = (now: number) => {
      const time = (now - startTime) / 1000
      context.clearRect(0, 0, width, height)
      context.globalCompositeOperation = 'lighter'
      const pointer = pointerRef.current
      pointer.x += (pointer.targetX - pointer.x) * 0.12
      pointer.y += (pointer.targetY - pointer.y) * 0.12
      pointer.influence += (pointer.targetInfluence - pointer.influence) * 0.08

      for (const particle of particles) {
        const baseX = offsetX + particle.x * scale
        const baseY = offsetY + particle.y * scale
        let x = baseX + Math.sin(time * particle.speed + particle.phase) * particle.driftX
        let y = baseY + Math.cos(time * particle.speed * 0.82 + particle.phase) * particle.driftY

        if (pointer.influence > 0.002 && !reducedMotion) {
          const dx = x - pointer.x
          const dy = y - pointer.y
          const distance = Math.hypot(dx, dy) || 1
          if (distance < POINTER_RADIUS) {
            const force = (1 - distance / POINTER_RADIUS) ** 1.7 * (particle.edge ? 6.5 : 16) * pointer.influence
            const tangentX = -dy / distance
            const tangentY = dx / distance
            x += dx / distance * force * 0.72 + tangentX * force * 0.68
            y += dy / distance * force * 0.72 + tangentY * force * 0.68
          }
        }

        const twinkle = reducedMotion ? 0.9 : 0.86 + Math.sin(time * particle.speed + particle.phase) * 0.1
        const radius = Math.max(0.48, particle.radius * scale * (0.94 + twinkle * 0.1))
        const alpha = Math.min(1, particle.alpha * twinkle)

        if (particle.edge) {
          context.beginPath()
          context.fillStyle = `rgba(${particle.color},${alpha * 0.12})`
          context.arc(x, y, radius * 2.5, 0, Math.PI * 2)
          context.fill()
          context.beginPath()
          context.fillStyle = `rgba(${particle.color},${alpha})`
          context.arc(x, y, radius, 0, Math.PI * 2)
          context.fill()
        } else {
          const size = Math.max(1, radius * 1.72)
          context.fillStyle = `rgba(${particle.color},${alpha})`
          context.fillRect(x - size * 0.5, y - size * 0.5, size, size)
        }
      }
      context.globalCompositeOperation = 'source-over'
      drawDataCallouts(context, scale, offsetX, offsetY, time, pointer, reducedMotion)
      animationFrame = requestAnimationFrame(draw)
    }

    const image = new Image()
    image.onload = () => {
      const sampled = buildParticles(image)
      // Below the floor the whale reads as noise, so the procedural fallback
      // stays. Say so: an empty background and a deliberately plain one look
      // identical on screen, and the usual cause is the source image being
      // unreachable rather than anything about the art.
      if (sampled.length > 250) particles = sampled
      else console.warn(`AuroraBackground: ${MASTER_SRC} yielded only ${sampled.length} particles — keeping the procedural field`)
    }
    image.onerror = () => {
      console.warn(`AuroraBackground: could not load ${MASTER_SRC} — keeping the procedural field`)
    }
    image.src = MASTER_SRC

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      pointerRef.current.targetX = event.clientX - rect.left
      pointerRef.current.targetY = event.clientY - rect.top
      pointerRef.current.targetInfluence = 1
    }
    const onPointerLeave = () => { pointerRef.current.targetInfluence = 0 }
    // Browsers throttle background rAF, but this dashboard is left open in a
    // tab for days at a time — stop drawing outright rather than relying on
    // how aggressively a given browser decides to throttle.
    const onVisibility = () => {
      cancelAnimationFrame(animationFrame)
      if (!document.hidden) animationFrame = requestAnimationFrame(draw)
    }
    const resizeObserver = new ResizeObserver(layout)
    resizeObserver.observe(root)
    layout()
    animationFrame = requestAnimationFrame(draw)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', onPointerLeave)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <div ref={rootRef} className="aurora-motion-canvas aurora-particle-whale" aria-hidden="true">
      <div className="aurora-motion-base" />
      <canvas ref={canvasRef} className="aurora-whale-canvas" />
    </div>
  )
}
