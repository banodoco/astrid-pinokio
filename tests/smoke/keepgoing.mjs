import fs from 'node:fs';
import path from 'node:path';

export const DIAGNOSTIC_KEEP_GOING_ENV = 'PINOKIO_DIAGNOSTIC_KEEP_GOING';
export const KEEP_GOING_REPORT_ENV = 'PINOKIO_KEEPGOING_REPORT';

export function diagnosticKeepGoingEnabled(environment = process.env) {
  return environment[DIAGNOSTIC_KEEP_GOING_ENV] === '1'
    || ['1', 'true'].includes(String(environment.INPUT_DIAGNOSTIC_KEEP_GOING || '').toLowerCase())
    || ['1', 'true'].includes(String(environment.DIAGNOSTIC_KEEP_GOING || '').toLowerCase());
}

function errorMessage(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function dependencySource(name, stages) {
  const dependency = [...stages].reverse().find((stage) => stage.stage === name);
  if (!dependency) return 'genuine';
  if (dependency.result === 'passed') return 'genuine';
  return `forced-by:${dependency.stage}`;
}

function continuationLabel(sources) {
  const forcedStages = [...new Set(sources.filter(({ source }) => source.startsWith('forced-by:'))
    .map(({ source }) => source.slice('forced-by:'.length)))];
  return forcedStages.length ? `continue-after:${forcedStages.join(',')}` : null;
}

export function createKeepGoingRecorder({ enabled = false, reportPath } = {}) {
  const stages = [];
  let firstError = null;

  async function run(stage, action, { needs = stages.length ? [stages.at(-1).stage] : [], produces = [] } = {}) {
    if (!enabled) return action();
    const sources = needs.map((name) => ({ need: name, source: dependencySource(name, stages) }));
    try {
      const value = await action();
      stages.push({ stage, result: 'passed', forced: continuationLabel(sources), first_error: null, needs: sources,
        preconditions: needs, postconditions: produces,
        class: sources.some(({ source }) => source.startsWith('forced-by:')) ? 'suspect' : 'real' });
      return value;
    } catch (error) {
      const message = errorMessage(error);
      firstError ??= { stage, message };
      stages.push({ stage, result: 'failed', forced: `continue-after:${stage}`, first_error: message,
        preconditions: needs, postconditions: [], expected_postconditions: produces,
        needs: sources,
        class: sources.some(({ source }) => source.startsWith('forced-by:'))
          ? `suspect:${[...new Set(sources.filter(({ source }) => source.startsWith('forced-by:')).map(({ source }) => source.slice('forced-by:'.length)))].join(',')}`
          : 'real' });
      process.stderr.write(`[pinokio-smoke] DIAGNOSTIC continue after ${stage}: ${message}\n`);
      return undefined;
    }
  }

  function skip(stage, needs = []) {
    if (!enabled) return;
    const sources = needs.map((name) => ({ need: name, source: dependencySource(name, stages) }));
    stages.push({ stage, result: 'skipped', forced: `skip-unavailable:${stage}`, first_error: null, needs: sources,
      preconditions: needs, postconditions: [],
      class: sources.some(({ source }) => source.startsWith('forced-by:')) ? 'suspect' : 'real' });
  }

  function report() {
    const dependencyTable = stages.map(({ stage, needs, preconditions, postconditions, expected_postconditions, result, class: failureClass }) => ({
      stage, needs: needs.map(({ need }) => need), preconditions, source: needs.map(({ need, source }) => ({ need, source })),
      postconditions, expected_postconditions: expected_postconditions ?? postconditions, result, class: failureClass,
    }));
    const nodes = stages.map(({ stage, result }, index) => `  stage_${index}[${JSON.stringify(stage)}]${result === 'failed' ? ':::failed' : ''}`).join('\n');
    const edges = [];
    stages.forEach((current, index) => {
      for (const { need, source } of current.needs) {
        let from = -1;
        for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
          if (stages[candidate].stage === need) { from = candidate; break; }
        }
        const to = stages.indexOf(current);
        if (from >= 0) edges.push(`  stage_${from} ${source.startsWith('forced-by:') ? '-.->' : '-->'} stage_${to}`);
      }
      if (!current.needs.length && index > 0 && current.forced) {
        edges.push(`  stage_${index - 1} -.-> stage_${index}`);
      }
    });
    const failures = stages.filter(({ result }) => result === 'failed');
    const realFailures = failures.filter(({ class: failureClass }) => failureClass === 'real');
    const suspectFailures = failures.filter(({ class: failureClass }) => failureClass !== 'real')
      .sort((left, right) => String(left.class).localeCompare(String(right.class)));
    return {
      schema: 1,
      proof_mode: 'keep-going-diagnostic',
      qualification: 'non-qualifying',
      first_error: firstError,
      failures: [...realFailures, ...suspectFailures].map(({ stage, first_error, class: failureClass }) => ({ stage, first_error, class: failureClass })),
      real_failures: realFailures.map(({ stage, first_error }) => ({ stage, first_error })),
      suspect_failures: suspectFailures.map(({ stage, first_error, class: failureClass }) => ({ stage, first_error, class: failureClass })),
      stages,
      dependency_table: dependencyTable,
      mermaid: `flowchart TD\n${nodes}\n${edges.join('\n')}\n  classDef failed fill:#f88,stroke:#900;`,
    };
  }

  function write() {
    if (!enabled) return null;
    const destination = path.resolve(reportPath || process.env[KEEP_GOING_REPORT_ENV] || path.join(process.env.RUNNER_TEMP || process.cwd(), 'keepgoing-report.json'));
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(report(), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
    return destination;
  }

  return { enabled, run, skip, report, write };
}
