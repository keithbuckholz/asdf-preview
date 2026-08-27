/* Integration harness: runs the compiled BackendManager against the real
 * python backend in plain Node (no VSCode). Stubs just enough of the vscode
 * API for manager.ts to run. Exercises: detection -> spawn -> handshake ->
 * open -> image -> hard kill -> auto-respawn.
 */
'use strict';
const Module = require('module');

const ROOT = '/Users/keith/asdf-preview';

const vscodeStub = {
  window: {
    createOutputChannel: (name) => ({
      appendLine: (m) => console.log(`  [output] ${m}`),
      dispose: () => {},
    }),
    createStatusBarItem: () => ({
      show() {}, hide() {}, dispose() {},
      text: '', tooltip: undefined, name: '', command: '',
    }),
  },
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d }), // defaults only
  },
  StatusBarAlignment: { Left: 1 },
  MarkdownString: class { constructor(s) { this.value = s; } },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

const { BackendManager } = require(ROOT + '/out/backend/manager.js');
const small = ROOT + '/testdata/small.asdf';
const big = ROOT + '/testdata/big.asdf';

async function main() {
  const mgr = new BackendManager(ROOT, { subscriptions: [] });
  let failures = 0;
  const check = (name, cond, extra) => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${extra && !cond ? ' -- ' + extra : ''}`);
    if (!cond) failures++;
  };

  console.log('== first request triggers spawn+handshake ==');
  const t0 = Date.now();
  const rec = await mgr.request('open', { path: small });
  check('cold open via manager', !!rec && rec.preview_array === 'data', JSON.stringify(rec).slice(0, 200));
  console.log(`  cold first-request total: ${Date.now() - t0} ms (python spawn + imports + parse)`);

  const caps = mgr.capabilities;
  check('capabilities captured', !!caps && !!caps.asdf, JSON.stringify(caps));

  console.log('== second open (cached) ==');
  const t1 = Date.now();
  const rec2 = await mgr.request('open', { path: small });
  check('hot open via manager', !!rec2);
  console.log(`  hot open: ${Date.now() - t1} ms`);
  check('hot is fast', Date.now() - t1 < 250);

  console.log('== image through manager ==');
  const img = await mgr.request('image', { path: small });
  check('png returned', typeof img.png === 'string' && img.png.length > 1000, String(img.png?.length));
  check('dims 512', img.width === 512 && img.height === 512);

  console.log('== hard kill (SIGKILL) -> E_BACKEND_DIED -> transparent respawn ==');
  const child = mgr.proc && mgr.proc['proc'];
  if (!child) throw new Error('no child handle for test');
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300)); // close event + rejectAll drain
  let diedErr = null;
  try {
    await mgr.request('ping', {});
  } catch (e) { diedErr = e; }
  check('next request after kill works (auto-respawn)', !diedErr, diedErr && `${diedErr.code}: ${diedErr.message}`);
  const rec3 = await mgr.request('open', { path: small });
  check('re-open after respawn', !!rec3);

  console.log('== restart command ==');
  await mgr.restart();
  const rec4 = await mgr.request('open', { path: big });
  check('restart + big open', !!rec4 && rec4.preview_array === 'data');
  const t2 = Date.now();
  const bigImg = await mgr.request('image', { path: big });
  check('big image 1024^2', bigImg.width === 1024 && bigImg.height === 1024);
  console.log(`  big file cold-open+image after restart: ${Date.now() - t2} ms`);

  mgr.dispose();
  await new Promise((r) => setTimeout(r, 300));
  if (failures) { console.log(`HOST SIM FAILED (${failures})`); process.exit(1); }
  console.log('HOST SIM PASSED');
}

main().catch((e) => {
  console.error('UNCAUGHT:', e.message, e.code || '', e.hint || '');
  process.exit(1);
});
