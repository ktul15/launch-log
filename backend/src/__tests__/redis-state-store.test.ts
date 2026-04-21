import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { RedisStateStore } from '../plugins/passport'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
})

afterAll(async () => {
  await app.close()
})

function makeStore() {
  return new RedisStateStore(app.redis)
}

function promiseStore(store: RedisStateStore, state: string): Promise<void> {
  return new Promise((resolve, reject) => {
    store.store({}, state, {}, (err) => (err ? reject(err) : resolve()))
  })
}

function promiseVerify(
  store: RedisStateStore,
  state: string,
): Promise<{ ok: boolean; returnedState?: string }> {
  return new Promise((resolve, reject) => {
    store.verify({}, state, {}, (err, ok, returnedState) => {
      if (err) reject(err)
      else resolve({ ok, returnedState })
    })
  })
}

function randomState() {
  return crypto.randomBytes(16).toString('base64url')
}

describe('RedisStateStore', () => {
  it('store then verify: succeeds and returns the state value', async () => {
    const stateStore = makeStore()
    const state = randomState()
    await promiseStore(stateStore, state)
    const result = await promiseVerify(stateStore, state)
    expect(result.ok).toBe(true)
    expect(result.returnedState).toBe(state)
  })

  it('verify without prior store (also models TTL-expired token): returns ok=false', async () => {
    // This test doubles as coverage for the TTL-expiry path: a Redis key that has expired
    // is indistinguishable from one that was never stored — DEL returns 0 in both cases.
    const stateStore = makeStore()
    const state = randomState()
    const result = await promiseVerify(stateStore, state)
    expect(result.ok).toBe(false)
  })

  it('replay attack: second verify on the same state returns ok=false', async () => {
    const stateStore = makeStore()
    const state = randomState()
    await promiseStore(stateStore, state)
    const first = await promiseVerify(stateStore, state)
    const second = await promiseVerify(stateStore, state)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
  })

  it('oversized state (>128 chars): returns ok=false without touching Redis', async () => {
    const stateStore = makeStore()
    const state = 'a'.repeat(129)
    const result = await promiseVerify(stateStore, state)
    expect(result.ok).toBe(false)
  })

  it('malformed state (contains +, /, = from base64): returns ok=false', async () => {
    const stateStore = makeStore()
    const state = 'valid+prefix/with=padding'
    const result = await promiseVerify(stateStore, state)
    expect(result.ok).toBe(false)
  })

  it('empty state string: returns ok=false', async () => {
    const stateStore = makeStore()
    const result = await promiseVerify(stateStore, '')
    expect(result.ok).toBe(false)
  })

  it('store() propagates Redis errors to the callback', async () => {
    const stateStore = makeStore()
    jest.spyOn(app.redis, 'set').mockRejectedValueOnce(new Error('Redis unavailable'))

    const err = await new Promise<Error | null>((resolve) => {
      stateStore.store({}, randomState(), {}, (e) => resolve(e))
    })

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('Redis unavailable')

    jest.restoreAllMocks()
  })
})
