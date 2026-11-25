import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { readSyncOptions } from '../../src/options.ts'

const options = {
  enabled: true,
  mode: 'continuous',
  sourceGatewayUrl: 'http://127.0.0.1:3425',
  centralGatewayUrl: 'https://center.example',
  centralKeyFile: resolve('fixture.key'),
  sourceCallerKeyId: 'fixture-key-id',
}

test('activation requires both enabled and the continuous mode', () => {
  expect(readSyncOptions(undefined)).toBeNull()
  expect(readSyncOptions({ enabled: false, mode: 'continuous' })).toBeNull()
  expect(() => readSyncOptions({ ...options, enabled: 'true' })).toThrow('invalid_enabled')
  expect(() => readSyncOptions({ ...options, mode: undefined, sourceCursor: 'fixture-cursor' })).toThrow('invalid_mode')
  expect(readSyncOptions(options)).toMatchObject({ initialMode: 'now', pollIntervalSec: 60, requestTimeoutSec: 30 })
  expect(readSyncOptions({ ...options, initialMode: 'start', pollIntervalSec: 5, requestTimeoutSec: 1 }))
    .toMatchObject({ initialMode: 'start', pollIntervalSec: 5, requestTimeoutSec: 1 })
  expect(readSyncOptions({ ...options, pollIntervalSec: 900, requestTimeoutSec: 120 }))
    .toMatchObject({ pollIntervalSec: 900, requestTimeoutSec: 120 })
})

test('options outside the dedicated scope and time bounds are rejected', () => {
  expect(() => readSyncOptions({ ...options, sourceCallerKeyId: 'none' })).toThrow('invalid_sourceCallerKeyId')
  expect(() => readSyncOptions({ ...options, sourceGatewayUrl: 'https://remote.example' })).toThrow('source_not_loopback')
  expect(() => readSyncOptions({ ...options, centralGatewayUrl: 'https://center.example/v1' })).toThrow('invalid_centralGatewayUrl')
  expect(() => readSyncOptions({ ...options, centralGatewayUrl: options.sourceGatewayUrl })).toThrow('same_gateway')
  expect(() => readSyncOptions({ ...options, centralKeyFile: 'fixture.key' })).toThrow('invalid_centralKeyFile')
  expect(() => readSyncOptions({ ...options, initialMode: null })).toThrow('invalid_initialMode')
  for (const pollIntervalSec of [4, 901, 5.1, '60']) {
    expect(() => readSyncOptions({ ...options, pollIntervalSec })).toThrow('invalid_pollIntervalSec')
  }
  for (const requestTimeoutSec of [0, 121, 1.5, '1']) {
    expect(() => readSyncOptions({ ...options, requestTimeoutSec })).toThrow('invalid_requestTimeoutSec')
  }
})
