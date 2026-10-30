'use strict';
const app = require('./lib');
module.exports = async () => {
  let roots;
  return { run: [
  app.customStep(async (req, ondata, kernel) => { roots = app.assertSafeRemoval(); const result = await app.stopForUninstall(req, ondata, kernel); roots = app.assertSafeRemoval(roots); return result; }),
  app.customStep(app.ensureDoorPortFree),
  app.shellStep(app.bootstrapScript('uninstall')),
  app.customStep(async () => { app.finishUninstall(roots); return { uninstalled: true, dataKept: true }; }),
] };
};
