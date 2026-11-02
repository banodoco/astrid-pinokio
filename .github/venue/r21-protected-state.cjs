'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function digestTree(target, { requireRoot = false, bindLinks = false } = {}) {
  const hash = crypto.createHash('sha256');
  async function visit(absolute, relative, output, ancestors = new Set()) {
    let entry;
    try { entry = await fsp.lstat(absolute); }
    catch (error) {
      if (error.code === 'ENOENT' && !(requireRoot && relative === '')) {
        output.update(`missing\0${relative}\0`); return;
      }
      if (error.code === 'ENOENT') throw new Error('protected tree root is missing');
      throw error;
    }
    if (entry.isDirectory()) {
      const real = await fsp.realpath(absolute);
      if (ancestors.has(real)) throw new Error('protected tree contains a cyclic directory link');
      const below = new Set(ancestors); below.add(real);
      output.update(`directory\0${relative}\0`);
      const names = (await fsp.readdir(absolute)).sort();
      for (const name of names) await visit(path.join(absolute, name), path.join(relative, name), output, below);
    } else if (entry.isFile()) {
      output.update(`file\0${relative}\0${sha256(await fsp.readFile(absolute))}\0`);
    } else if (entry.isSymbolicLink()) {
      const link = await fsp.readlink(absolute);
      if (!bindLinks) {
        output.update(`symlink\0${relative}\0${link}\0`);
        return;
      }
      let real;
      try { real = await fsp.realpath(absolute); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error('protected installed tree contains a dangling link');
        throw error;
      }
      const targetHash = crypto.createHash('sha256');
      await visit(real, '', targetHash, ancestors);
      // Bind both the link declaration and all bytes reached through it. The
      // receipt publishes only this enclosing digest, never either path.
      output.update(`symlink\0${relative}\0${link}\0${targetHash.digest('hex')}\0`);
    } else {
      if (bindLinks) throw new Error('protected installed tree contains a non-file entry');
      output.update(`other\0${relative}\0`);
    }
  }
  await visit(path.resolve(target), '', hash);
  return hash.digest('hex');
}

function selectedName(bytes) {
  const name = bytes.toString('utf8').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === '.' || name === '..') {
    throw new Error('installed version selection is invalid');
  }
  return name;
}

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function regular(pathname, label) {
  let entry;
  try { entry = await fsp.lstat(pathname); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`selected installed ${label} is missing`);
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`selected installed ${label} is not a regular file`);
}

async function selectedVersion(root, current) {
  const name = selectedName(current);
  const versionsRoot = path.resolve(root, 'versions');
  const selectedRoot = path.resolve(versionsRoot, name);
  if (!inside(versionsRoot, selectedRoot)) throw new Error('installed version escaped its versions root');
  for (const [pathname, label] of [[versionsRoot, 'versions root'], [selectedRoot, 'version root']]) {
    let entry;
    try { entry = await fsp.lstat(pathname); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`selected installed ${label} is missing`);
      throw error;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`selected installed ${label} is not a regular directory`);
  }
  const manifestPath = path.join(selectedRoot, 'manifest.json');
  const versionPath = path.join(selectedRoot, 'version.json');
  await regular(manifestPath, 'manifest');
  await regular(versionPath, 'version record');
  let record;
  try { record = JSON.parse(await fsp.readFile(versionPath, 'utf8')); }
  catch { throw new Error('selected installed version record cannot be read'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) || path.resolve(record.root || '') !== selectedRoot) {
    throw new Error('selected installed version record does not bind its version root');
  }
  for (const [field, label] of [['python', 'Python'], ['profile', 'profile']]) {
    if (typeof record[field] !== 'string' || !path.isAbsolute(record[field]) || !inside(selectedRoot, path.resolve(record[field]))) {
      throw new Error(`selected installed ${label} escaped its version root`);
    }
    let target;
    try { target = await fsp.stat(record[field]); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`selected installed ${label} is missing`);
      throw error;
    }
    if (!target.isFile()) throw new Error(`selected installed ${label} target is not a file`);
  }
  return { name, versionsRoot, selectedRoot, manifestPath };
}

async function digestProtectedState(appRoot, home) {
  const root = path.join(appRoot, 'app', 'astrid');
  const program = crypto.createHash('sha256');
  for (const name of ['current', 'install.json', 'update-transaction.json']) {
    const file = path.join(root, name);
    try { program.update(`${name}\0${sha256(await fsp.readFile(file))}\0`); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      program.update(`${name}\0missing\0`);
    }
  }
  let current;
  try { current = await fsp.readFile(path.join(root, 'current')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('installed version selection cannot be read for protected-state observation');
  }
  const { versionsRoot } = await selectedVersion(root, current);
  let dataRoot;
  try {
    const install = JSON.parse(await fsp.readFile(path.join(root, 'install.json'), 'utf8'));
    dataRoot = path.resolve(install.data_root);
  } catch {
    throw new Error('installed data root cannot be read for protected-state observation');
  }
  if (!inside(path.resolve(home), dataRoot)) throw new Error('installed data root escaped the disposable Pinokio home');
  return {
    program: program.digest('hex'),
    selected_version: sha256(current),
    // Hash the complete installed versions tree, not only its pointer and
    // manifests. A refused first click must not stage or mutate any program byte.
    installed_bytes: await digestTree(versionsRoot, { requireRoot: true, bindLinks: true }),
    // Digests expose no paths, names, contents, timestamps, or raw logs.
    user_data: await digestTree(dataRoot),
  };
}

async function installedTupleMatches(appRoot, tuple) {
  const root = path.join(appRoot, 'app', 'astrid');
  const selected = await selectedVersion(root, await fsp.readFile(path.join(root, 'current')));
  const manifest = JSON.parse(await fsp.readFile(selected.manifestPath, 'utf8'));
  return manifest?.agent?.sha === tuple.agent && manifest?.runtime?.sha === tuple.runtime;
}

// This private command specification is used only by the R-21 diagnostic
// observer.  Callers must never retain it: it contains installed paths.  Keep
// its selected-tree and venue-home checks alongside the structural observer so
// an arbitrary install record cannot turn the diagnostic into an arbitrary
// command launcher.
async function runtimeStatusSpec(appRoot, home) {
  const root = path.join(appRoot, 'app', 'astrid');
  const selected = await selectedVersion(root, await fsp.readFile(path.join(root, 'current')));
  let record;
  let install;
  try {
    record = JSON.parse(await fsp.readFile(path.join(selected.selectedRoot, 'version.json'), 'utf8'));
    install = JSON.parse(await fsp.readFile(path.join(root, 'install.json'), 'utf8'));
  } catch { throw new Error('installed Runtime status record cannot be read'); }
  const python = path.resolve(record?.python || '');
  const data = path.resolve(install?.data_root || '');
  if (!inside(selected.selectedRoot, python)) throw new Error('installed Runtime Python escaped its version root');
  if (!inside(path.resolve(home), data)) throw new Error('installed Runtime data root escaped the disposable Pinokio home');
  return { command: python, args: ['-I', '-m', 'astrid_runtime', 'status', '--data-root', data, '--json'], cwd: root };
}

module.exports = { digestProtectedState, digestTree, installedTupleMatches, runtimeStatusSpec };
