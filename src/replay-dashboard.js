// Dashboard-only presentation. Live state keeps arriving through CLIENT_HELPERS.
export const DASHBOARD_REPLAY = `
    let broadcast = null, broadcastRevision = -1, broadcastInstance = null;
    let broadcastOffset = 0, broadcastFrame = -1, broadcastMap = null;
    let broadcastGeneration = 0, broadcastRequest = 0, broadcastFailedId = null;
    const replayEl = id => document.getElementById(id);
    function ceremonyActive() {
      return state.phase === 'finale' && state.finale &&
        Date.now() + broadcastOffset - Date.parse(state.finale.startedAt) < state.finale.data.length * 13500;
    }
    function hideTimelapse() {
      broadcast = null; broadcastMap = null; broadcastFrame = -1;
      replayEl('timelapseStage').style.display = 'none';
    }
    function renderTimelapse() {
      if (!broadcast) return false;
      const now = Date.now() + broadcastOffset;
      if (now >= broadcast.endsAt || state.phase === 'lobby' || ceremonyActive()) {
        hideTimelapse(); return false;
      }
      try {
        const replay = broadcast.replay;
        const frame = Math.min(replay.frames.length - 1, Math.max(0, Math.floor((now-broadcast.startedAt)/broadcast.frameMs)));
        if (!broadcastMap || frame < broadcastFrame) {
          broadcastMap = replay.map.map(t => ({...t})); broadcastFrame = -1;
        }
        if (frame !== broadcastFrame) {
          for (let i=broadcastFrame+1;i<=frame;i++) for (const c of replay.frames[i].changes) {
            Object.assign(broadcastMap[c.index], {owner:c.owner}, c.warded ? {warded:1,capital:c.capital} : {});
          }
          renderMap(replayEl('timelapseMap'), broadcastMap, replay.players);
          broadcastFrame = frame;
        }
        replayEl('timelapseLabel').textContent = replay.frames[frame].label + ' / ' + replay.totalTurns + ' completed turns';
        replayEl('timelapseStatus').textContent = frame === replay.frames.length-1
          ? 'Last saved turn · returning to the dashboard shortly'
          : 'Territory history · the game continues in the background';
        replayEl('timelapseStage').style.display = 'flex';
        for (const id of ['lobby','live','finaleStage','dashboardTicker']) replayEl(id).style.display = 'none';
        replayEl('phaseline').textContent = 'MAP TIMELAPSE';
        return true;
      } catch {
        broadcastFailedId = broadcast.id; hideTimelapse(); return false;
      }
    }
    function receiveTimelapse(packet) {
      if (!packet || !Number.isSafeInteger(packet.revision) || !Number.isFinite(packet.serverNow)) return;
      if (broadcastInstance !== null && packet.instance !== broadcastInstance) return;
      if (packet.revision < broadcastRevision) return;
      broadcastInstance = packet.instance; broadcastRevision = packet.revision;
      broadcastOffset = packet.serverNow - Date.now();
      const next = packet.playback;
      if (!next || next.id === broadcastFailedId || !next.replay || !Array.isArray(next.replay.players) || !Array.isArray(next.replay.map) || !Array.isArray(next.replay.frames) || !next.replay.frames.length || !Number.isFinite(next.endsAt) ||
          !Number.isFinite(next.startedAt) || !(next.frameMs > 0) || next.endsAt <= packet.serverNow) {
        hideTimelapse(); render(); return;
      }
      if (!broadcast || broadcast.id !== next.id) {
        broadcastMap = null; broadcastFrame = -1;
        replayEl('timelapseLegend').textContent = next.replay.players.map(p=>p.empire+' ['+p.abbr+']').join(' · ');
      }
      broadcast = next; render();
    }
    async function syncTimelapse() {
      const generation = broadcastGeneration, request = ++broadcastRequest;
      try {
        const response = await fetch('/api/timelapse', {cache:'no-store',signal:AbortSignal.timeout(4000)});
        if (!response.ok) throw new Error('Timelapse unavailable');
        const packet = await response.json();
        if (generation === broadcastGeneration && request === broadcastRequest) receiveTimelapse(packet);
      } catch {
        if (generation === broadcastGeneration && request === broadcastRequest) { hideTimelapse(); render(); }
      }
    }
    socket.on('timelapse', packet => { ++broadcastRequest; receiveTimelapse(packet); });
    socket.on('connect', () => {
      ++broadcastGeneration; broadcastInstance = null; broadcastRevision = -1;
      hideTimelapse(); render(); syncTimelapse();
    });
    socket.on('disconnect', () => { ++broadcastGeneration; hideTimelapse(); render(); });
    setInterval(() => { if (broadcast) render(); }, 100);
    setInterval(() => { if (socket.connected) syncTimelapse(); }, 5000);
    window.addEventListener('pageshow', () => { if (socket.connected) syncTimelapse(); });
    window.addEventListener('pagehide', () => { ++broadcastGeneration; hideTimelapse(); });
`;
