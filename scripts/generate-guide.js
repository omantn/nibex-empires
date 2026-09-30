import fs from 'node:fs'
process.env.NIBEX_DB=':memory:'
const {publicState}=await import('../src/game.js')
const {howToPlayPage}=await import('../src/views.js')
fs.writeFileSync(new URL('../HOW-TO-PLAY.html',import.meta.url),howToPlayPage(publicState(),{defaults:true}))
