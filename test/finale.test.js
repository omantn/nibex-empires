import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { dashboardPage } from '../src/views.js'

const row = { id: 1, empire: 'Alpha', abbr: 'AA', color: '#123456', name: 'Alice', territory: 4, resources: 3, army: 2, relics: 5, total: 14 }
const beats = { territory: 1500, resources: 3000, army: 4200, relics: 5400, total: 6400, id: 7600, empire: 7600, abbr: 7600, color: 7600, name: 10000 }
const revealed = time => Object.fromEntries(Object.entries(beats).filter(([, at]) => time > at).map(([key]) => [key, row[key]]))

function ceremony() {
  const html = dashboardPage({ players: [], map: [] }, 'http://localhost/join', '', [])
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const source = script.slice(script.indexOf('const PER_RANK'), script.indexOf('let boomed'))
  let content = '', renders = 0
  const stage = { get innerHTML() { return content }, set innerHTML(value) { content = value; renders++ } }
  const context = {
    state: { finale: { startedAt: new Date(0).toISOString(), data: [{}, {}] } },
    clock: 0,
    document: { getElementById() { return stage } },
    serverTime() { return context.clock },
    escH: String,
    boom() {},
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  return { context, stage, render: () => vm.runInContext('renderFinale()', context), renders: () => renders }
}

test('a delayed server snapshot reveals the name without waiting for another ceremony beat', () => {
  const { context, stage, render, renders } = ceremony()
  context.state.finale.data[0] = revealed(9800)
  context.clock = 10250
  render()
  assert.doesNotMatch(stage.innerHTML, /Alice/)
  context.state.finale.data[0] = revealed(10800)
  context.clock = 11000
  render()
  assert.match(stage.innerHTML, /Alice/)
  const count = renders()
  context.clock = 11250
  render()
  assert.equal(renders(), count, 'unchanged frames should remain cached')
})

test('a score arriving after its clock beat appears immediately', () => {
  const { context, stage, render } = ceremony()
  context.clock = 1750
  render()
  assert.doesNotMatch(stage.innerHTML, /Territory/)
  context.state.finale.data[0] = revealed(1800)
  context.clock = 2000
  render()
  assert.match(stage.innerHTML, /Territory/)
  assert.doesNotMatch(stage.innerHTML, /Alice/)
})

test('champion standings refresh when the final server fields arrive', () => {
  const { context, stage, render } = ceremony()
  context.state.finale.data = [revealed(9800)]
  context.clock = 13750
  render()
  assert.doesNotMatch(stage.innerHTML, /Alice/)
  context.state.finale.data = [row]
  context.clock = 14000
  render()
  assert.match(stage.innerHTML, /Alice/)
})

test('replaying the finale invalidates the prior ceremony frame', () => {
  const { context, render, renders } = ceremony()
  context.clock = 500
  render()
  const count = renders()
  context.state.finale.startedAt = new Date(1000).toISOString()
  context.clock = 1500
  render()
  assert.equal(renders(), count + 1)
})
