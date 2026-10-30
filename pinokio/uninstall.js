'use strict';
const app = require('./lib');
module.exports = async () => ({ run: [
  app.customStep(app.stopForUninstall),
  app.customStep(app.ensureDoorPortFree),
  app.shellStep(app.bootstrapScript('uninstall')),
  app.customStep(async () => { app.finishUninstall(); return { uninstalled: true, dataKept: true }; }),
] });
