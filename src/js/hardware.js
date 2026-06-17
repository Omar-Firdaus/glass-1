/**
 * Unified hardware sidebar status + connect/disconnect all.
 */

const MUSE_BUSY_STATES = new Set([
  'streaming',
  'connected',
  'connecting',
  'waiting_stream',
  'scanning',
]);

function museSidebarLabel(state) {
  if (state === 'streaming' || state === 'connected') return 'Muse connected';
  if (['scanning', 'connecting', 'waiting_stream', 'disconnected'].includes(state)) {
    return 'Muse connecting…';
  }
  if (state === 'error') return 'Muse error';
  return 'Muse offline';
}

function cameraSidebarLabel(state) {
  if (state === 'live') return 'PC Cam live';
  if (state === 'starting') return 'PC Cam starting…';
  if (state === 'error') return 'PC Cam error';
  return 'PC Cam off';
}

function setHwDot(el, stateClass, useMuseDot = false) {
  if (!el) return;
  el.className = useMuseDot ? 'muse-status-dot' : 'hw-dot';
  el.classList.add(stateClass);
}

function updateHardwareSidebar(cameraState, museState) {
  const camDot = document.getElementById('hw-camera-dot');
  const camLabel = document.getElementById('hw-camera-label');
  const museDot = document.getElementById('hw-muse-dot');
  const museLabel = document.getElementById('hw-muse-label');

  const camDotClass = cameraState === 'live' ? 'live' : cameraState === 'starting' ? 'starting' : cameraState === 'error' ? 'error' : 'idle';
  setHwDot(camDot, camDotClass);
  if (camLabel) camLabel.textContent = cameraSidebarLabel(cameraState);

  const museDotClass =
    museState === 'streaming'
      ? 'streaming'
      : museState === 'connected'
        ? 'connected'
        : ['scanning', 'connecting', 'waiting_stream'].includes(museState)
          ? 'connecting'
          : museState === 'error'
            ? 'error'
            : 'idle';

  setHwDot(museDot, museDotClass, true);
  if (museLabel) museLabel.textContent = museSidebarLabel(museState);
}

document.addEventListener('DOMContentLoaded', () => {
  let cameraState = 'idle';
  let museState = 'idle';

  const refreshSidebar = () => updateHardwareSidebar(cameraState, museState);

  if (window.camera) {
    window.camera.onStatus((status) => {
      cameraState = status.state || 'idle';
      refreshSidebar();
    });
  }

  if (window.muse) {
    window.muse.getStatus().then((status) => {
      if (status) {
        museState = status.state || 'idle';
        refreshSidebar();
      }
    });

    window.muse.onStatus((status) => {
      museState = status.state || 'idle';
      refreshSidebar();
    });
  }

  document.getElementById('hardware-connect-all')?.addEventListener('click', async () => {
    const tasks = [];
    if (window.camera && !window.camera.active) {
      tasks.push(window.camera.start().catch(() => {}));
    }
    if (window.muse) {
      const status = await window.muse.getStatus();
      if (!status || !MUSE_BUSY_STATES.has(status.state)) {
        tasks.push(window.muse.connect().catch(() => {}));
      }
    }
    await Promise.all(tasks);
  });

  document.getElementById('hardware-disconnect-all')?.addEventListener('click', async () => {
    if (window.camera?.active) window.camera.stop();
    if (window.muse) await window.muse.disconnect();
  });

  refreshSidebar();
});
