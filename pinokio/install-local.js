'use strict';
const app = require('./lib');
module.exports = async () => ({ run: [
  // Direct re-invocation can target a running local install with its door off.
  // Preserve refusals before pulling its editor checkout or changing its mode.
  ...(app.readInstallMode() || app.hasOwnedSupervisor() ? [app.customStep(app.stopOwnedStart)] : []),
  app.customStep(app.ensureDoorPortFree),
  app.customStep(async () => app.ensureProgramDirectory()),
  app.gitShellStep(app.validateExistingEditorCheckout() ? app.pullEditorMessage() : app.cloneEditorMessage()),
  app.shellStep(app.bootstrapScript('install', app.paths.join(app.EDITOR_DIR, 'public', 'install-manifest.json'))),
  app.sessionStep('build', 'local'),
  app.saveModeStep('local'),
] });
