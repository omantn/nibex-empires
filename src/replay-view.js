import { layout, MAP_RENDERER } from './views.js'
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const json = value => JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026')

export function replayPage(replay) {
  const nav = '<a href="/admin">Back to Admin</a> · <a href="/dashboard">Open dashboard</a>'
  if (!replay.available) return layout('Timelapse — Nibex: Empires', `<h1>Map timelapse</h1><p>${nav}</p><div class="card" role="status">${esc(replay.reason)}</div>`)
  return layout('Timelapse — Nibex: Empires', `
    <header><div><h1>Map timelapse</h1><p>${nav}</p></div><strong id="turn" aria-live="polite"></strong></header>
    <svg id="replayMap" role="img" aria-label="Territory ownership map"></svg>
    <div id="legend">${replay.players.map(p => `<span><i class="dot" style="background:${esc(p.color)}"></i>${esc(p.empire)} [${esc(p.abbr)}]</span>`).join('')}</div>
    <div class="card"><div class="btnrow">
      <button id="play">Play</button><button id="restart">Restart</button>
      <button id="previous" aria-label="Previous frame">Previous</button><button id="next" aria-label="Next frame">Next</button>
      <label for="speed">Speed</label><select id="speed"><option value="1600">Slow</option><option value="800" selected>Normal</option><option value="300">Fast</option></select>
      <button id="fullscreen">Fullscreen</button>
    </div><label for="seek">Timeline</label><input id="seek" type="range" min="0" max="${replay.frames.length-1}" value="0" step="1">
    <p id="status" role="status">Ready to play.</p><p class="muted">${esc(replay.note)}</p>
    <p class="muted">Playback never starts the winner reveal. Use Start Finale in Admin when you are ready.</p></div>`, `
    ${MAP_RENDERER}
    const replay = ${json(replay)};
    const $ = id => document.getElementById(id);
    let position=0, timer=null;
    function pause() { if(timer!==null)clearTimeout(timer);timer=null;$('play').textContent='Play'; }
    function draw() {
      const map=replay.map.map(t=>({...t}));
      for(let i=0;i<=position;i++)for(const c of replay.frames[i].changes)Object.assign(map[c.index],{owner:c.owner},c.warded?{warded:1,capital:c.capital}:{});
      renderMap($('replayMap'),map,replay.players);
      $('turn').textContent=replay.frames[position].label+' / '+replay.totalTurns+' turns';
      $('seek').value=position;
      $('previous').disabled=position===0;$('next').disabled=position===replay.frames.length-1;
      $('status').textContent=position===replay.frames.length-1?'End of saved history. The game is unchanged.':'Territory history';
    }
    function safeDraw(){try{draw();return true;}catch{pause();$('status').textContent='Playback failed. Return to Admin; the game and finale are unaffected.';return false;}}
    function schedule(){timer=setTimeout(()=>{timer=null;if(position<replay.frames.length-1){position++;if(!safeDraw())return;}if(position>=replay.frames.length-1)pause();else schedule();},Number($('speed').value));}
    $('play').onclick=()=>{if(timer!==null){pause();return;}if(position>=replay.frames.length-1)position=0;if(!safeDraw())return;if(replay.frames.length>1){$('play').textContent='Pause';schedule();}};
    $('restart').onclick=()=>{pause();position=0;safeDraw();};
    $('previous').onclick=()=>{pause();position=Math.max(0,position-1);safeDraw();};
    $('next').onclick=()=>{pause();position=Math.min(replay.frames.length-1,position+1);safeDraw();};
    $('seek').oninput=()=>{pause();position=Number($('seek').value);safeDraw();};
    $('speed').onchange=()=>{if(timer!==null){pause();$('play').textContent='Pause';schedule();}};
    $('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{$('status').textContent='Fullscreen is unavailable. Playback still works in this window.';}};
    addEventListener('pagehide',pause);document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
    safeDraw();
  `, {css:'.wrap{max-width:1600px}header{display:flex;justify-content:space-between;gap:20px;align-items:center;flex-wrap:wrap}#replayMap{display:block;width:100%;height:60vh;min-height:240px}#legend{display:flex;gap:8px 20px;flex-wrap:wrap}#seek{width:100%}.btnrow{align-items:center}.btnrow label{margin:0}#status{margin:10px 0}.muted{font-size:.9rem}button{min-height:44px}:fullscreen{background:#0d1117;overflow:auto}'})
}
