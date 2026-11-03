import fs from 'node:fs';
import path from 'node:path';

export const DIAGNOSTIC_KEEP_GOING_ENV = 'PINOKIO_DIAGNOSTIC_KEEP_GOING';
export const KEEP_GOING_REPORT_ENV = 'PINOKIO_KEEPGOING_REPORT';
export function diagnosticKeepGoingEnabled(environment = process.env) {
  return environment[DIAGNOSTIC_KEEP_GOING_ENV] === '1' || environment.diagnostic_keep_going === 'true';
}
const unique = values => [...new Set(values)];
const message = error => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 8192);

export function createKeepGoingRecorder({ enabled = false, reportPath, metadata = {} } = {}) {
  const stages = [];
  let firstError = null;
  function sourcesFor(needs) {
    return needs.map(need => {
      const dependency = [...stages].reverse().find(row => row.stage === need && row.result !== 'running');
      const forced = dependency ? unique([...(dependency.forced_origins || []), ...(dependency.result === 'passed' ? [] : [need])]) : [need];
      return { need, source: forced.length ? `forced-by:${forced.join(',')}` : 'genuine',
        available: Boolean(dependency), forced_stages: forced };
    });
  }
  async function run(stage, action, { needs, produces = [] } = {}) {
    if (!enabled) return action();
    needs ??= stages.filter(row => row.result !== 'running').length
      ? [stages.filter(row => row.result !== 'running').at(-1).stage] : [];
    const sources = sourcesFor(needs);
    const upstream = unique(sources.flatMap(source => source.forced_stages));
    const row = { stage, result: 'running', forced: null, first_error: null, needs: sources,
      preconditions: needs, postconditions: [], expected_postconditions: produces,
      forced_origins: upstream, class: upstream.length ? `suspect:${upstream.join(',')}` : 'real',
      started_at: new Date().toISOString(), inner_exit: null };
    stages.push(row);
    write();
    try {
      const value = await action();
      Object.assign(row, { result: 'passed', action_result: value && typeof value === 'object' ? value : null, postconditions: produces,
        forced: upstream.length ? `continue-after:${upstream.join(',')}` : null });
      return value;
    } catch (error) {
      const errorText = message(error);
      firstError ??= { stage, message: errorText };
      Object.assign(row, { result: 'failed', forced: `continue-after:${stage}`, first_error: errorText,
        forced_origins: unique([...upstream, stage]), inner_exit: error?.inner_exit ?? null,
        cleanup: error?.cleanup ?? null });
      process.stderr.write(`[pinokio-smoke] DIAGNOSTIC continue after ${stage}: ${errorText}\n`);
      return undefined;
    } finally {
      row.ended_at = new Date().toISOString();
      write();
    }
  }
  function skip(stage, needs = []) {
    if (!enabled) return;
    const sources = sourcesFor(needs);
    const origins = unique(sources.flatMap(source => source.forced_stages));
    stages.push({ stage, result: 'skipped', forced: `skip-unavailable:${stage}`, first_error: null,
      needs: sources, preconditions: needs, postconditions: [], forced_origins: unique([...origins, stage]),
      class: origins.length ? `suspect:${origins.join(',')}` : 'real' });
    write();
  }
  function report() {
    const failures = stages.filter(row => row.result === 'failed');
    const real = failures.filter(row => row.class === 'real');
    const suspect = failures.filter(row => row.class !== 'real').sort((a, b) => a.class.localeCompare(b.class));
    const summarize = ({ stage, first_error, class: kind }) => ({ stage, first_error, class: kind });
    const groups = {};
    for (const row of suspect) (groups[row.class.slice(8)] ??= []).push(summarize(row));
    const graph = ['flowchart TD'];
    const escape = value => String(value).replace(/["<>\r\n]/g, ' ');
    stages.forEach((row, index) => {
      graph.push(`  stage_${index}["${escape(row.stage)}"]${row.result === 'failed' ? ':::failed' : ''}`);
      for (const source of row.needs) {
        let prior = -1;
        for (let n = index - 1; n >= 0; n--) if (stages[n].stage === source.need) { prior = n; break; }
        if (prior >= 0) graph.push(`  stage_${prior} ${source.source === 'genuine' ? '-->' : '-.->'} stage_${index}`);
      }
    });
    graph.push('  classDef failed fill:#f88,stroke:#900;');
    return { real_failures: real.map(summarize), suspect_failures: suspect.map(summarize),
      suspect_by_forced_stage: groups, schema: 1, proof_mode: 'keep-going-diagnostic',
      qualification: 'non-qualifying', qualification_eligible: false, diagnostic_keep_going: true,
      first_error: firstError, failures: [...real, ...suspect].map(summarize), metadata, stages,
      dependency_table: stages.map(row => ({ stage: row.stage, needs: row.preconditions,
        source: row.needs, result: row.result, class: row.class, postconditions: row.postconditions })),
      mermaid: graph.join('\n'),
      limitations: { independent_start_jobs: 'not implemented in first dispatch', alternate_forcing_cross_checks: 'not implemented in first dispatch' } };
  }
  function write() {
    if (!enabled) return null;
    const destination = path.resolve(reportPath || process.env[KEEP_GOING_REPORT_ENV] || path.join(process.env.RUNNER_TEMP || process.cwd(), 'keepgoing-report.json'));
    fs.writeFileSync(`${destination}.tmp`, `${JSON.stringify(report(), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(`${destination}.tmp`, destination);
    return destination;
  }
  function captureFirstError(stage, error) {
    if (!enabled) return;
    firstError ??= { stage, message: message(error) };
    write();
  }
  return { enabled, run, skip, report, write, metadata, captureFirstError };
}
