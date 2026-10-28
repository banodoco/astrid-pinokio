'use strict';
const app = require('./lib');
module.exports = async () => {
  if (app.readInstallMode() !== 'backend') throw new Error('Astrid is already fully local.');
  return { run: [
    app.customStep(app.stopOwnedStart),
    app.customStep(app.ensureDoorPortFree),
    app.gitShellStep(app.validateExistingEditorCheckout() ? app.pullEditorMessage() : app.cloneEditorMessage()),
    app.shellStep(app.bootstrapScript('update', app.paths.join(app.EDITOR_DIR, 'public', 'install-manifest.json'))),
    // Update starts a managed backend session. Release it through the same
    // fenced stop as the initial session before the local build takes ownership.
    app.customStep(app.stopOwnedStart),
    app.sessionStep('build', 'local'),
    app.saveModeStep('local'),
  ] };
};
