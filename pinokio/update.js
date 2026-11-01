'use strict';
const app = require('./lib');
module.exports = async () => {
  // A pending transaction is recovered before launcher/editor inputs change.
  // The installed CLI exits after recovery, so the user can retry Update.
  if (app.hasPendingUpdate()) return { run: [app.customStep(app.recoverPendingUpdate)] };
  const mode = app.readInstallMode();
  if (!mode) throw new Error("Astrid isn't fully installed. Choose Reset, then install again.");
  if (mode === 'local') {
    if (!app.validateExistingEditorCheckout()) throw new Error("Astrid's editor files are missing. Choose Reset, then install again.");
    return { run: [
      app.customStep(app.updateLocal),
      { method: 'script.start', params: { uri: 'start.js' } },
    ] };
  }
  // Backend C2 stages its candidate before invoking the final C1 stop fence.
  return { run: [app.customStep(app.preflightStop), app.gitShellStep(app.launcherPullMessage()),
    app.shellStep(app.bootstrapScript('install'))] };
};
