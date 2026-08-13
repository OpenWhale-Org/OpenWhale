export type ParticleWave = {
  x: number
  y: number
  directionX: number
  directionY: number
  bornAt: number
  phase: number
}

export type ParticleWaveOptions = {
  maxRadius: number
  duration: number
  strength: number
}

export type DirectionalParticleWaveOptions = ParticleWaveOptions & {
  bandWidth: number
  forwardStretch: number
  sideStretch: number
  swirl: number
}

export type ParticleWaveEmitter = {
  waves: ParticleWave[]
  lastX: number
  lastY: number
  lastAt: number
}

export function createParticleWaveEmitter(): ParticleWaveEmitter {
  return {
    waves: [],
    lastX: Number.NaN,
    lastY: Number.NaN,
    lastAt: 0,
  }
}

export function emitParticleWave(
  emitter: ParticleWaveEmitter,
  x: number,
  y: number,
  now: number,
  minimumDistance: number,
  maximumInterval: number,
  maxWaves = 3,
  minimumWaveInterval = 0,
) {
  const hasPreviousPoint = Number.isFinite(emitter.lastX) && Number.isFinite(emitter.lastY)
  const deltaX = hasPreviousPoint ? x - emitter.lastX : 1
  const deltaY = hasPreviousPoint ? y - emitter.lastY : 0
  const distance = Math.hypot(deltaX, deltaY)
  const elapsed = now - emitter.lastAt

  if (hasPreviousPoint && elapsed < minimumWaveInterval) return
  if (hasPreviousPoint && distance < minimumDistance && elapsed < maximumInterval) return

  const directionX = distance > 0.01 ? deltaX / distance : 1
  const directionY = distance > 0.01 ? deltaY / distance : 0
  emitter.waves.push({
    x,
    y,
    directionX,
    directionY,
    bornAt: now,
    phase: ((x * 0.017 + y * 0.031 + now * 0.0007) % 1) * Math.PI * 2,
  })
  emitter.waves = emitter.waves.slice(-maxWaves)
  emitter.lastX = x
  emitter.lastY = y
  emitter.lastAt = now
}

export function resetParticleWaveEmitter(emitter: ParticleWaveEmitter) {
  emitter.lastX = Number.NaN
  emitter.lastY = Number.NaN
  emitter.lastAt = 0
}

export function pruneParticleWaves(emitter: ParticleWaveEmitter, now: number, duration: number) {
  if (emitter.waves.length === 0) return
  emitter.waves = emitter.waves.filter(wave => now - wave.bornAt < duration)
}

export function displaceByParticleWaves(
  x: number,
  y: number,
  waves: ParticleWave[],
  now: number,
  options: ParticleWaveOptions,
  strengthScale = 1,
) {
  let offsetX = 0
  let offsetY = 0

  for (const wave of waves) {
    const age = Math.max(0, (now - wave.bornAt) / options.duration)
    if (age <= 0) continue

    const relativeX = x - wave.x
    const relativeY = y - wave.y
    const distance = Math.hypot(relativeX, relativeY) || 1
    const progress = 1 - (1 - Math.min(1, age)) ** 1.8
    const currentRadius = options.maxRadius * progress
    if (distance >= currentRadius) continue

    const safeDistance = distance || 1
    const radialX = relativeX / safeDistance
    const radialY = relativeY / safeDistance
    const force = (1 - distance / Math.max(1, currentRadius)) ** 1.55 * options.strength * strengthScale

    offsetX += radialX * force
    offsetY += radialY * force
  }

  // Several fresh waves may overlap while the pointer is moving quickly. Keep the
  // combined motion controlled so the artwork ripples without tearing apart.
  const offset = Math.hypot(offsetX, offsetY)
  const maximumOffset = options.strength * strengthScale * 1.28
  if (offset > maximumOffset) {
    const clamp = maximumOffset / offset
    offsetX *= clamp
    offsetY *= clamp
  }

  return { x: x + offsetX, y: y + offsetY }
}

export function displaceByDirectionalParticleWaves(
  x: number,
  y: number,
  waves: ParticleWave[],
  now: number,
  options: DirectionalParticleWaveOptions,
  strengthScale = 1,
) {
  let offsetX = 0
  let offsetY = 0

  for (const wave of waves) {
    const age = (now - wave.bornAt) / options.duration
    if (age <= 0 || age >= 1) continue

    const relativeX = x - wave.x
    const relativeY = y - wave.y
    const along = relativeX * wave.directionX + relativeY * wave.directionY
    const across = -relativeX * wave.directionY + relativeY * wave.directionX
    const alongStretch = along >= 0 ? options.forwardStretch : 0.92
    const ellipticalDistance = Math.hypot(along / alongStretch, across / options.sideStretch)
    const progress = 1 - (1 - age) ** 2.35
    const waveFront = options.maxRadius * progress
    const width = options.bandWidth * (0.72 + progress * 0.48)
    const distanceFromFront = (ellipticalDistance - waveFront) / width
    const band = Math.exp(-distanceFromFront * distanceFromFront * 1.8)
    if (band < 0.006) continue

    const fadeIn = Math.min(1, age / 0.09)
    const envelope = fadeIn * (1 - age) ** 1.05
    const distance = Math.hypot(relativeX, relativeY) || 1
    const radialX = relativeX / distance
    const radialY = relativeY / distance
    const tangentX = -radialY
    const tangentY = radialX
    const angle = Math.atan2(across, along)
    const organicPulse = 0.9 + Math.sin(angle * 2.6 + wave.phase + age * 5.2) * 0.1
    const directionCosine = along / Math.max(1, distance)
    const forwardBias = 0.12 + ((directionCosine + 1) * 0.5) ** 1.8 * 0.88
    const force = options.strength * strengthScale * band * envelope * organicPulse * forwardBias
    const swirl = Math.sin(angle * 1.8 + wave.phase + progress * 3.4) * options.swirl

    offsetX += radialX * force + tangentX * force * swirl
    offsetY += radialY * force + tangentY * force * swirl
  }

  const offset = Math.hypot(offsetX, offsetY)
  const maximumOffset = options.strength * strengthScale * 1.28
  if (offset > maximumOffset) {
    const clamp = maximumOffset / offset
    offsetX *= clamp
    offsetY *= clamp
  }

  return { x: x + offsetX, y: y + offsetY }
}
