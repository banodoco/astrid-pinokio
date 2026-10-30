'use strict';
const app = require('./lib');
module.exports = async () => ({ run: [
  app.customStep(app.stopForRemoval),
  app.customStep(async () => { app.assertSafeRemoval(); app.removeProgramFiles(); return { reset: true, dataKept: true }; }),
] });
