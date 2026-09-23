import fs from 'node:fs'
process.env.NIBEX_DB=':memory:'
const {publicState}=await import('../src/game.js')
const {playPage}=await import('../src/views.js')
const html=playPage({id:0,empire:'Your empire',abbr:'YOU',name:'Player'},publicState(),{})
const help=html.match(/<details>[\s\S]*?<\/details>/)?.[0]
if(!help)throw Error('Player help section not found')
fs.writeFileSync(new URL('../HOW-TO-PLAY.html',import.meta.url),`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>How to play — Nibex: Empires</title>
<style>body{font:17px/1.55 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 24px;color:#17202a}p{margin:12px 0}summary{display:none}h1{line-height:1.2}@media print{body{font-size:11pt;margin:0}}</style>
<h1>Nibex: Empires</h1><p>Plan your moves, make your deals, and enjoy the weekend. Your real name stays private until the final trophy ceremony.</p>
<p>This guide uses the default settings. The live How to play panel shows the host's configured turn length and daily budget.</p>
${help.replace('<details>','<details open>')}
<p><b>At the deadline:</b> pending orders expire and paid resources return before scores are frozen. There is no extra final turn. Ties use total points, then territory points, then earlier registration.</p>
</html>`)
