const PROOF_APP_REF = '641e7347efe2396856c9311ea76f2e07e3e719cb';

export function smokeTarget(flow) {
  if (flow === 'hosted') return Object.freeze({ appRef: 'main' });
  if (flow === 'hosted-proof-manifest') return Object.freeze({ appRef: PROOF_APP_REF });
  throw new Error(`Unknown hosted smoke target: ${flow}`);
}
