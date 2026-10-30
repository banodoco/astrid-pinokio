'use strict';
const app = require('./pinokio/lib');
const infoItem = (text) => ({ icon: 'fa-solid fa-circle-info', text });
const openItem = (target) => ({ icon: 'fa-solid fa-arrow-up-right-from-square', text: 'Open Astrid', ...target });
const item = (text, script, icon) => ({ icon: `fa-solid fa-${icon}`, text, href: `pinokio/${script}.js` });

module.exports = {
  version: '8.0.0',
  menu: async (_kernel, info) => {
    const operations = [
      ['install', 'Installing Astrid…'], ['install-local', 'Installing Astrid fully local…'],
      ['add-local', 'Switching to fully local…'], ['update', 'Updating Astrid…'],
      ['reset', 'Resetting Astrid…'], ['uninstall', 'Uninstalling Astrid…'],
      ['uninstall-delete-data', 'Uninstalling Astrid and deleting its data…'], ['stop', 'Stopping Astrid…'],
    ];
    const active = operations.find(([script]) => info.running(`pinokio/${script}.js`));
    if (active) return [infoItem(active[1])];
    const mode = app.readInstallMode();
    const installed = Boolean(mode && (info.exists('app/astrid/run') || info.exists('app/astrid/run.cmd')));
    if (info.running('pinokio/start.js')) {
      const local = info.local('pinokio/start.js') || {};
      const ready = local.url === app.modeOpenTarget(mode).href && local.mode === mode;
      if (!ready) return [infoItem('Starting Astrid…'), item('Stop', 'stop', 'stop')];
      const open = mode === 'local'
        ? openItem({ href: local.url, popout: false })
        : openItem({ href: '/', target_full: local.url, popout: true });
      open.default = true;
      return [open, ...(mode ? [item(mode === 'backend' ? 'Update and restart' : 'Update', 'update', 'rotate')] : []), item('Stop', 'stop', 'stop')];
    }
    if (mode === 'local' && installed && app.hasOwnedSupervisor()) {
      if (!await app.localSessionReady()) return [infoItem('Starting Astrid…'), item('Stop', 'stop', 'stop')];
      return [openItem(app.modeOpenTarget('local')), item('Update', 'update', 'rotate'), item('Stop', 'stop', 'stop')];
    }
    const port = await app.probeDoor();
    if (port.kind === 'astrid' && installed && app.hasOwnedSupervisor()) {
      return [openItem(app.modeOpenTarget(mode)), ...(mode === 'backend' ? [item('Update and restart', 'update', 'rotate')] : []), item('Stop', 'stop', 'stop')];
    }
    if (port.kind === 'astrid') return [infoItem('Astrid is already running on this computer. Use Open Astrid, or stop that copy to run Astrid from Pinokio.'), openItem(app.modeOpenTarget('backend'))];
    if (port.kind === 'occupied') return [infoItem("Another program is using port 17340, so Astrid can't start. Close it, then try again.")];
    if (!installed) return [item('Install', 'install', 'download'), item('Install fully local', 'install-local', 'laptop')];
    const items = [item('Start', 'start', 'play'), item('Update', 'update', 'rotate')];
    items[0].default = true;
    if (mode === 'backend') items.push(item('Switch to fully local', 'add-local', 'laptop'));
    items.push(item('Reset', 'reset', 'broom'), item('Uninstall', 'uninstall', 'trash-can-arrow-up'),
      item('Uninstall and delete all Astrid data…', 'uninstall-delete-data', 'triangle-exclamation'));
    return items;
  },
};
