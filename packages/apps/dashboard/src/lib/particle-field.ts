export type ParticleField = {
  x: number
  y: number
  targetX: number
  targetY: number
  radius: number
  active: boolean
}

export type ParticleFieldOptions = {
  maxRadius: number
  strength: number
  followSpeed?: number
  expansionSpeed?: number
}

export function createParticleField(): ParticleField {
  return {
    x: -9999,
    y: -9999,
    targetX: -9999,
    targetY: -9999,
    radius: 0,
    active: false,
  }
}

export function moveParticleField(field: ParticleField, x: number, y: number) {
  if (!field.active) {
    field.x = x
    field.y = y
    field.radius = 0
    field.active = true
  }
  field.targetX = x
  field.targetY = y
}

export function advanceParticleField(field: ParticleField, options: ParticleFieldOptions) {
  if (!field.active) return
  const followSpeed = options.followSpeed ?? 0.24
  const expansionSpeed = options.expansionSpeed ?? 0.075
  field.x += (field.targetX - field.x) * followSpeed
  field.y += (field.targetY - field.y) * followSpeed
  field.radius += (options.maxRadius - field.radius) * expansionSpeed
  if (options.maxRadius - field.radius < 0.1) field.radius = options.maxRadius
}

export function displaceByParticleField(
  x: number,
  y: number,
  field: ParticleField,
  options: ParticleFieldOptions,
  strengthScale = 1,
) {
  if (!field.active || field.radius < 1) return { x, y }
  const deltaX = x - field.x
  const deltaY = y - field.y
  const distance = Math.hypot(deltaX, deltaY) || 1
  if (distance >= field.radius) return { x, y }

  const influence = 1 - distance / field.radius
  const force = influence ** 1.55 * options.strength * strengthScale
  return {
    x: x + deltaX / distance * force,
    y: y + deltaY / distance * force,
  }
}
