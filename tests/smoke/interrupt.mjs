import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function interruptAtJournal(child, journalPath, kill, { timeoutMs = 600_000, log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!child.closed && Date.now() < deadline) {
    let journal;
    try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (['stopping', 'stopped', 'migrated', 'switched'].includes(journal?.step)) {
      log(`interrupting Update at durable journal phase ${journal.step}`);
      await kill(child);
      const result = await child.exit;
      assert.notEqual(result.code, 0, 'Update completed before interruption');
      return journal.step;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!child.closed) { await kill(child); await child.exit; }
  throw new Error('Update exited or timed out before an interruptible journal phase was observed.');
}
