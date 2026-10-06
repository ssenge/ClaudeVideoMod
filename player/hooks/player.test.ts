import { expect, test } from 'claude-code/testing'

const presentation = { isFullscreen: false, columns: 120 }
const origin = { kind: 'plugin', name: 'test' } as const

test('/play off disarms and says so', { options: { source: '' } }, async $ => {
  const r = await $.command.run({ command: 'play', args: 'off', origin, presentation })
  expect(r.text).toBe('Player off.')
})

test('/play without a url or configured source asks for one', { options: { source: '' } }, async $ => {
  const r = await $.command.run({ command: 'play', args: '', origin, presentation })
  expect(r.text).toBe('No source: /play <url>, or set one in /config.')
})
