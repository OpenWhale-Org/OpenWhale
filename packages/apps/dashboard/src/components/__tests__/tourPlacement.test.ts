import { afterEach, describe, expect, it } from 'vitest'
import { placeCard } from '../tourPlacement'

function rect(input: { left: number; top: number; right: number; bottom: number }): DOMRect {
  return {
    ...input,
    width: input.right - input.left,
    height: input.bottom - input.top,
    x: input.left,
    y: input.top,
    toJSON: () => ({}),
  }
}

function overlaps(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

describe('guided-tour card placement', () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  })

  it('keeps the card outside a near-full-screen form like issue #48', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { innerWidth: 1234, innerHeight: 620 },
    })

    // Geometry reconstructed from the 1234×620 screenshot attached to #48.
    const form = rect({ left: 103, top: 55, right: 1050, bottom: 590 })
    const style = placeCard(form)
    const card = {
      left: Number(style.left),
      top: Number(style.top),
      right: Number(style.left) + Number(style.width),
      bottom: Number(style.top) + 160,
    }

    expect(overlaps(card, form)).toBe(false)
  })
})
