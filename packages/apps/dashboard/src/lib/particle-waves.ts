export type ParticleWave = {
  x: number
  y: number
  bornAt: number
}

export type ParticleWaveOptions = {
  maxRadius: number
  duration: number
  strength: number
  bandWidth: number
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

  emitter.waves.push({
    x,
    y,
    bornAt: now,
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
    const age = (now - wave.bornAt) / options.duration
    if (age <= 0 || age >= 1) continue

    const relativeX = x - wave.x
    const relativeY = y - wave.y
    const distance = Math.hypot(relativeX, relativeY)
    const expansion = Math.min(1, age / 0.72)
    const progress = 1 - (1 - expansion) ** 1.55
    const waveFront = options.maxRadius * progress
    const width = options.bandWidth * (0.72 + progress * 0.48)
    const distanceFromFront = (distance - waveFront) / width
    const band = Math.exp(-distanceFromFront * distanceFromFront * 1.8)
    if (band < 0.006) continue

    const fadeIn = Math.min(1, age / 0.09)
    const fadeOut = age < 0.72 ? 1 : (1 - age) / 0.28
    const envelope = fadeIn * fadeOut
    const safeDistance = distance || 1
    const radialX = relativeX / safeDistance
    const radialY = relativeY / safeDistance
    const force = options.strength * strengthScale * band * envelope

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
