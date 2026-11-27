import { expect, test } from 'bun:test'
import { readCenterOptions, readGatewayUrl } from '../../src/options.ts'

test('only the explicitly enabled pull mode starts the center and uses a loopback gateway', () => {
  const options = { collectionMode: 'pull', enabled: true }
  expect(readCenterOptions({})).toBeNull()
  expect(readCenterOptions({ enabled: true, role: 'center', ingestPort: 3494 })).toBeNull()
  expect(readCenterOptions({ enabled: true, mode: 'continuous' })).toBeNull()
  expect(readCenterOptions({ ...options, enabled: false })).toBeNull()
  expect(readCenterOptions(options)?.gateway.href).toBe('http://127.0.0.1:3425/')
  expect(readCenterOptions(options)?.timeoutMs).toBe(30_000)
  expect(readCenterOptions({ ...options, centerGatewayUrl: 'https://[::1]:4525', requestTimeoutSec: 120 })?.timeoutMs)
    .toBe(120_000)
  expect(() => readCenterOptions({ ...options, centerGatewayUrl: 'https://remote.example' })).toThrow('center_not_loopback')
  expect(() => readCenterOptions({ ...options, centerGatewayUrl: 'http://127.0.0.1/path' })).toThrow('invalid_centerGatewayUrl')
  expect(() => readCenterOptions({ ...options, requestTimeoutSec: 0 })).toThrow('invalid_requestTimeoutSec')
  expect(() => readCenterOptions({ ...options, requestTimeoutSec: '30' })).toThrow('invalid_requestTimeoutSec')
  expect(() => readCenterOptions({ ...options, configRevision: 'invalid' })).toThrow('invalid_config_revision')
  expect(() => readCenterOptions({ ...options, enabled: 'true' })).toThrow('invalid_enabled')
})

test('gateway roots permit HTTP and HTTPS authority syntax and reject extra URL components', () => {
  expect(readGatewayUrl('HTTP://Example.COM:3425/')?.href).toBe('http://example.com:3425/')
  expect(readGatewayUrl('https://[::1]:3425')?.href).toBe('https://[::1]:3425/')
  for (const url of ['ftp://test.example/', 'http://test.example?', 'https://test.example/#', 'http://fixture@test.example',
    'http://@test.example', 'http://test.example/other/..', 'http://test.example\\/', 'http://test.example/\n', null]) {
    expect(readGatewayUrl(url)).toBeUndefined()
  }
})
