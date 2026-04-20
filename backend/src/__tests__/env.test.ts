describe('Environment config validation', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    // Restore original env and registry — prevents cross-file module cache pollution
    jest.resetModules()
    process.env = originalEnv
  })

  function setValidEnv() {
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/db'
    process.env.REDIS_URL = 'redis://:pw@localhost:6379'
    process.env.JWT_SECRET = 'a'.repeat(32)
    process.env.JWT_REFRESH_SECRET = 'b'.repeat(32)
  }

  it('parses valid env vars without throwing', () => {
    setValidEnv()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { env } = require('../config/env')
    expect(env.PORT).toBe(3001)
    expect(env.JWT_ACCESS_EXPIRES_IN).toBe('15m')
    expect(env.JWT_REFRESH_EXPIRES_IN).toBe('7d')
  })

  it('exits if DATABASE_URL is missing', () => {
    setValidEnv()
    delete process.env.DATABASE_URL
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('exits if JWT_SECRET is too short', () => {
    setValidEnv()
    process.env.JWT_SECRET = 'tooshort'
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('exits if JWT_REFRESH_SECRET is too short', () => {
    setValidEnv()
    process.env.JWT_REFRESH_SECRET = 'tooshort'
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('rejects JWT_ACCESS_EXPIRES_IN with invalid format', () => {
    setValidEnv()
    process.env.JWT_ACCESS_EXPIRES_IN = '15 minutes'
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('coerces PORT from string to number', () => {
    setValidEnv()
    process.env.PORT = '4000'
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { env } = require('../config/env')
    expect(env.PORT).toBe(4000)
    expect(typeof env.PORT).toBe('number')
  })

  it('defaults NODE_ENV to development when not set', () => {
    setValidEnv()
    delete process.env.NODE_ENV
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { env } = require('../config/env')
    expect(env.NODE_ENV).toBe('development')
  })
})
