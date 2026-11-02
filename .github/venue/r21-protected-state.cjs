'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function digestTree(target, { requireRoot = false, bindLinks = false } = {}) {
  const root = path.resolve(target);
  const hash = crypto.createHash('sha256');
  let realRoot = null;

  async function visit(absolute, relative, output) {
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
      if (relative === '' && bindLinks) {
        realRoot = await fsp.realpath(absolute);
      }
      output.update(`directory\0${relative}\0`);
      const names = (await fsp.readdir(absolute)).sort();
      for (const name of names) await visit(path.join(absolute, name), path.join(relative, name), output);
    } else if (entry.isFile()) {
      output.update(`file\0${relative}\0${sha256(await fsp.readFile(absolute))}\0`);
    } else if (entry.isSymbolicLink()) {
      const link = await fsp.readlink(absolute);
      if (!bindLinks) {
        output.update(`symlink\0${relative}\0${link}\0`);
        return;
      }
      // A link can be bound only to a regular file inside the snapshot root.
      // This prevents a protected-state read from silently following an
      // arbitrary external tree or recursively amplifying a directory link.
      const lexicalTarget = path.resolve(path.dirname(absolute), link);
      if (!inside(root, lexicalTarget)) throw new Error('protected tree link escaped its root');
      let real;
      try { real = await fsp.realpath(absolute); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error('protected installed tree contains a dangling link');
        throw error;
      }
      if (!realRoot || !inside(realRoot, real)) throw new Error('protected tree link escaped its root');
      const target = await fsp.stat(real);
      if (!target.isFile()) throw new Error('protected tree link target is not a regular file');
      // Bind both the link declaration and its bounded target bytes. The
      // receipt publishes only this enclosing digest, never either path.
      output.update(`symlink\0${relative}\0${link}\0${sha256(await fsp.readFile(real))}\0`);
    } else {
      if (bindLinks) throw new Error('protected installed tree contains a non-file entry');
      output.update(`other\0${relative}\0`);
    }
  }
  await visit(root, '', hash);
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

async function requiredRegular(pathname, label) {
  let entry;
  try { entry = await fsp.lstat(pathname); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`protected installed ${label} is missing`);
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`protected installed ${label} is not a regular file`);
}

async function optionalRegular(pathname, label) {
  let entry;
  try { entry = await fsp.lstat(pathname); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`protected installed ${label} is not a regular file`);
}

async function protectedDataRoot(home, rawDataRoot) {
  if (typeof rawDataRoot !== 'string' || !path.isAbsolute(rawDataRoot)) {
    throw new Error('installed data root escaped the disposable Pinokio home');
  }
  const homeRoot = path.resolve(home);
  const dataRoot = path.resolve(rawDataRoot);
  if (!inside(homeRoot, dataRoot)) throw new Error('installed data root escaped the disposable Pinokio home');
  let entry;
  try { entry = await fsp.lstat(dataRoot); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('protected user data root is missing');
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('protected user data root is not a regular directory');
  }
  if (!inside(await fsp.realpath(homeRoot), await fsp.realpath(dataRoot))) {
    throw new Error('installed data root escaped the disposable Pinokio home');
  }
  return dataRoot;
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
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.root !== 'string' || !path.isAbsolute(record.root) || path.resolve(record.root) !== selectedRoot) {
    throw new Error('selected installed version record does not bind its version root');
  }
  const realSelectedRoot = await fsp.realpath(selectedRoot);
  for (const [field, label] of [['python', 'Python'], ['profile', 'profile']]) {
    if (typeof record[field] !== 'string' || !path.isAbsolute(record[field]) || !inside(selectedRoot, path.resolve(record[field]))) {
      throw new Error(`selected installed ${label} escaped its version root`);
    }
    const pathname = path.resolve(record[field]);
    let real;
    try { real = await fsp.realpath(pathname); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`selected installed ${label} is missing`);
      throw error;
    }
    if (!inside(realSelectedRoot, real)) throw new Error(`selected installed ${label} escaped its version root`);
    let target;
    try { target = await fsp.stat(real); }
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
  const currentPath = path.join(root, 'current');
  const installPath = path.join(root, 'install.json');
  await requiredRegular(currentPath, 'version selection');
  await requiredRegular(installPath, 'record');
  await optionalRegular(path.join(root, 'update-transaction.json'), 'update transaction');
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
  let install;
  try {
    install = JSON.parse(await fsp.readFile(installPath, 'utf8'));
  } catch {
    throw new Error('installed data root cannot be read for protected-state observation');
  }
  const dataRoot = await protectedDataRoot(home, install.data_root);
  return {
    program: program.digest('hex'),
    selected_version: sha256(current),
    // Hash the complete installed versions tree, not only its pointer and
    // manifests. A refused first click must not stage or mutate any program byte.
    installed_bytes: await digestTree(versionsRoot, { requireRoot: true, bindLinks: true }),
    // Digests expose no paths, names, contents, timestamps, or raw logs.
    user_data: await digestTree(dataRoot, { requireRoot: true, bindLinks: true }),
  };
}

async function installedTupleMatches(appRoot, tuple) {
  const root = path.join(appRoot, 'app', 'astrid');
  const currentPath = path.join(root, 'current');
  await regular(currentPath, 'version selection');
  const selected = await selectedVersion(root, await fsp.readFile(currentPath));
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
  const currentPath = path.join(root, 'current');
  const installPath = path.join(root, 'install.json');
  await regular(currentPath, 'version selection');
  await requiredRegular(installPath, 'record');
  const selected = await selectedVersion(root, await fsp.readFile(currentPath));
  let record;
  let install;
  try {
    record = JSON.parse(await fsp.readFile(path.join(selected.selectedRoot, 'version.json'), 'utf8'));
    install = JSON.parse(await fsp.readFile(installPath, 'utf8'));
  } catch { throw new Error('installed Runtime status record cannot be read'); }
  const python = path.resolve(record?.python || '');
  const data = await protectedDataRoot(home, install?.data_root);
  if (!inside(selected.selectedRoot, python)) throw new Error('installed Runtime Python escaped its version root');
  return { command: python, args: ['-I', '-m', 'astrid_runtime', 'status', '--data-root', data, '--json'], cwd: root };
}

module.exports = { digestProtectedState, digestTree, installedTupleMatches, runtimeStatusSpec };
