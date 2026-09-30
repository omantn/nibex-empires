import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { howToPlayPage, playPage } from '../src/views.js'

const defaults = { tickIntervalMin: 180, ordersPerDay: 20 }
const rules = html => html.match(/<div[^>]*class="help">([\s\S]*?)<\/div>/)?.[1]

test('public guide and player panel contain the same full rules', () => {
  const state = { tickIntervalMin: 90, ordersPerDay: 12 }
  const guide = howToPlayPage(state)
  const panel = playPage({ id: 1, empire: 'Example', abbr: 'EX', name: 'Private name' }, state, {})
  assert.ok(rules(guide))
  assert.equal(rules(guide), rules(panel))
  assert.match(guide, /every 90 minutes/)
  assert.match(guide, /receive 12 orders/)
  assert.match(guide, /earlier registration/)
  assert.match(guide, /<html lang="en">/)
  assert.doesNotMatch(guide, /<script|<details|Private name/)
})

test('guide escapes configured values and does not serialize game state', () => {
  const unsafe = '<img src=x onerror=alert(1)>'
  const guide = howToPlayPage({ tickIntervalMin: unsafe, ordersPerDay: unsafe, players: [{ name: 'Private name' }] })
  assert.ok(!guide.includes(unsafe))
  assert.match(guide, /&lt;img/)
  assert.doesNotMatch(guide, /Private name/)
})

test('printable export stays in sync with the shared guide', () => {
  const guide = howToPlayPage(defaults, { defaults: true })
  assert.equal(fs.readFileSync(new URL('../HOW-TO-PLAY.html', import.meta.url), 'utf8'), guide)
  assert.match(guide, /This guide uses the default settings/)
  assert.doesNotMatch(guide, /<nav/)
})
