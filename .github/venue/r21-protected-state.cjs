'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function digestTree(target) {
  const hash = crypto.createHash('sha256');
  async function visit(relative) {
    const absolute = path.join(target, relative);
    let entry;
    try { entry = await fsp.lstat(absolute); }
    catch (error) {
      if (error.code === 'ENOENT') { hash.update(`missing\0${relative}\0`); return; }
      throw error;
    }
    if (entry.isDirectory()) {
      hash.update(`directory\0${relative}\0`);
      const names = (await fsp.readdir(absolute)).sort();
      for (const name of names) await visit(path.join(relative, name));
    } else if (entry.isFile()) {
      hash.update(`file\0${relative}\0${sha256(await fsp.readFile(absolute))}\0`);
    } else if (entry.isSymbolicLink()) {
      hash.update(`symlink\0${relative}\0${await fsp.readlink(absolute)}\0`);
    } else {
      hash.update(`other\0${relative}\0`);
    }
  }
  await visit('');
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
  const name = selectedName(current);
  const versionsRoot = path.resolve(root, 'versions');
  const selectedRoot = path.resolve(versionsRoot, name);
  if (!inside(versionsRoot, selectedRoot)) throw new Error('installed version escaped its versions root');
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
    installed_bytes: await digestTree(versionsRoot),
    // Digests expose no paths, names, contents, timestamps, or raw logs.
    user_data: await digestTree(dataRoot),
  };
}

async function installedTupleMatches(appRoot, tuple) {
  const root = path.join(appRoot, 'app', 'astrid');
  const name = selectedName(await fsp.readFile(path.join(root, 'current')));
  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'versions', name, 'manifest.json'), 'utf8'));
  return manifest?.agent?.sha === tuple.agent && manifest?.runtime?.sha === tuple.runtime;
}

module.exports = { digestProtectedState, digestTree, installedTupleMatches };
