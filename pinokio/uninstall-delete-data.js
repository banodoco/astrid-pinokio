'use strict';
const app = require('./lib');
module.exports = async () => ({ run: [
  { method: 'input', params: {
    title: 'Delete all Astrid data?',
    description: "This uninstalls Astrid and permanently deletes your projects and all other Astrid data on this computer. It can't be undone.",
    form: [{ type: 'text', key: 'confirmation', title: 'Type DELETE to continue', required: true, placeholder: 'DELETE' }],
  } },
  app.customStep(async (req) => {
    if (req.input?.confirmation !== 'DELETE') throw new Error('Cancelled, so nothing was deleted. To go ahead, type DELETE in capitals.');
    return { confirmed: true };
  }),
  app.customStep(app.stopForUninstall),
  app.customStep(app.ensureDoorPortFree),
  app.shellStep(app.bootstrapScript('uninstall', undefined, true)),
  app.customStep(async () => { app.finishUninstall(); return { uninstalled: true, dataDeleted: true }; }),
] });
