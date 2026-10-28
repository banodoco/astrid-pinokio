'use strict';
const app = require('./lib');
module.exports = async () => {
  // A pending transaction is recovered before launcher/editor inputs change.
  // The installed CLI exits after recovery, so the user can retry Update.
  if (app.hasPendingUpdate()) {
    if (app.hasPendingLocalUpdate()) return { run: [
      app.customStep(app.ensureLocalSessionForUpdate),
      app.customStep(app.runLocalUpdate),
    ] };
    return { run: [app.customStep(app.recoverPendingUpdate)] };
  }
  const mode = app.readInstallMode();
  if (!mode) throw new Error("Astrid isn't fully installed. Choose Reset, then install again.");
  // The shared installer transaction preflights before staging, then uses
  // Runtime down as the final stop authority after candidate validation.
  const steps = [app.gitShellStep(app.launcherPullMessage())];
  if (mode === 'local') {
    if (!app.validateExistingEditorCheckout()) throw new Error("Astrid's editor files are missing. Choose Reset, then install again.");
    steps.push(
      app.customStep(app.ensureLocalSessionForUpdate),
      app.customStep(app.runLocalUpdate),
    );
  } else steps.push(app.shellStep(app.bootstrapScript('install')));
  return { run: steps };
};
