import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { OpenWhaleRuntime } from '@openwhaleorg/core'
import type { CredentialStore } from '@openwhaleorg/core'
import { exchangePlugin } from '../../plugin.js'
import { PerpAccount } from '../PerpAccount.js'
import { SpotAccount } from '../SpotAccount.js'
import { MockPerpAdapter } from '../../mock/MockPerpAdapter.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-spot-matrix-'))

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => ({ type: 'fakevenue', data: {} }),
  delete: async () => undefined,
  list: async () => [],
}

describe('type × kind matrix: one credential, two kinds', () => {
  it('the same credential type materializes perp AND spot readers', async () => {
    const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore })
    runtime.loadPlugin(exchangePlugin, {})
    // A fake venue whose ONE credential type has factories for both kinds —
    // exactly the binance shape
    runtime.registerCredentialType({
      type: 'fakevenue',
      factories: {
        'exchange/perp': () => new MockPerpAdapter(),
        'exchange/spot': () => new MockPerpAdapter(),
      } as never,
    })

    const info = runtime.describeCredentialTypes().find(t => t.type === 'fakevenue')!
    expect(info.kinds.sort()).toEqual(['exchange/perp', 'exchange/spot'])
  })

  it('spot kind wraps sessions in SpotAccount, perp in PerpAccount (account implementations)', () => {
    const plugin = exchangePlugin({ credentials: credentialStore, config: {} })
    const impls = Object.fromEntries(
      (plugin.accounts! as import('@openwhaleorg/core').AccountImplementation[]).map(a => [a.kind, a]),
    )

    const spotReader = impls['exchange/spot']!.createReader(new MockPerpAdapter(), 'Acct A')
    const perpReader = impls['exchange/perp']!.createReader(new MockPerpAdapter(), 'Acct A')
    expect(spotReader).toBeInstanceOf(SpotAccount)
    expect(perpReader).toBeInstanceOf(PerpAccount)
    expect((spotReader as SpotAccount).name).toBe('Acct A')
  })

  it("the mock cells define the kinds' derived vocabulary", () => {
    const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore })
    runtime.loadPlugin(exchangePlugin, {})
    expect(runtime.listKinds().sort()).toEqual(['exchange/perp', 'exchange/spot'])
  })
})
