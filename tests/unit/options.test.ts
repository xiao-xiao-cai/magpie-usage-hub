import { expect, test } from 'bun:test'
import { readOptions, readGatewayUrl } from '../../src/options.ts'

test('explicitly enabled center settings use a loopback gateway and a separate receiver', () => {
  const options = { collectionMode: 'otlp', role: 'center', enabled: true }
  expect(readOptions({})).toBeNull()
  expect(readOptions({ enabled: true, role: 'center', ingestPort: 3494 })).toBeNull()
  expect(readOptions({ ...options, collectionMode: 'pull' })).toBeNull()
  expect(readOptions({ ...options, enabled: false })).toBeNull()
  expect(readOptions(options)).toMatchObject({ timeoutMs: 30_000,
    ingestHost: '127.0.0.1', ingestPort: 3494, timeZone: 'Asia/Shanghai' })
  expect(readOptions(options)?.gateway.href).toBe('http://127.0.0.1:3425/')
  expect(readOptions({ ...options, centerGatewayUrl: 'https://[::1]:4525', requestTimeoutSec: 120 })?.timeoutMs).toBe(120_000)
  expect(() => readOptions({ ...options, centerGatewayUrl: 'https://remote.example' })).toThrow('gateway_not_loopback')
  expect(() => readOptions({ ...options, centerGatewayUrl: 'http://127.0.0.1/path' })).toThrow('invalid_centerGatewayUrl')
  expect(() => readOptions({ ...options, ingestPort: 3493 })).toThrow('invalid_ingestPort')
  expect(() => readOptions({ ...options, ingestHost: 'localhost' })).toThrow('invalid_ingestHost')
  expect(() => readOptions({ ...options, timeZone: '+08:00' })).toThrow('invalid_timeZone')
  expect(() => readOptions({ ...options, requestTimeoutSec: 0 })).toThrow('invalid_requestTimeoutSec')
  expect(() => readOptions({ ...options, requestTimeoutSec: '30' })).toThrow('invalid_requestTimeoutSec')
  expect(() => readOptions({ ...options, configRevision: 'invalid' })).toThrow('invalid_config_revision')
  expect(() => readOptions({ ...options, enabled: 'true' })).toThrow('invalid_enabled')
})

test('previous center options retain the listener settings on upgrade', () => {
  const options = { collectionMode: 'push', role: 'center', enabled: true, ingestHost: '0.0.0.0', ingestPort: 4494 }
  expect(readOptions(options)).toMatchObject({ ingestHost: '0.0.0.0', ingestPort: 4494 })
  expect(readOptions({ ...options, role: 'sender' })).toBeNull()
  expect(() => readOptions({ ...options, collectionMode: 'otlp', role: 'sender' })).toThrow('invalid_role')
})

test('gateway roots permit HTTP and HTTPS authority syntax and reject extra URL components', () => {
  expect(readGatewayUrl('HTTP://Example.COM:3425/')?.href).toBe('http://example.com:3425/')
  expect(readGatewayUrl('https://[::1]:3425')?.href).toBe('https://[::1]:3425/')
  for (const url of ['ftp://test.example/', 'http://test.example?', 'https://test.example/#', 'http://fixture@test.example',
    'http://@test.example', 'http://test.example/other/..', 'http://test.example\\/', 'http://test.example/\n', null]) {
    expect(readGatewayUrl(url)).toBeUndefined()
  }
})
