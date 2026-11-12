'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Base variables for parity with the login-service environment.
const BASE = ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'PWD', 'SHELL',
  'TMPDIR', 'USER', 'USERNAME', 'VIRTUAL_ENV', 'PYENV_VERSION'];
const WINDOWS = ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'SYSTEMROOT', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432', 'WINDIR', 'SYSTEMDRIVE', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'PUBLIC', 'PSMODULEPATH',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
  'OS', 'COMPUTERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'LOGONSERVER'];
const LINUX = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY'];
const PROXIES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'];

function pinokioHome(appDirectory, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!p.isAbsolute(appDirectory) || p.basename(p.dirname(appDirectory)).toLowerCase() !== 'api') {
    throw new Error('Expected the Pinokio app at <Pinokio home>/api/<app>.');
  }
  const home = p.dirname(p.dirname(appDirectory));
  if (home === p.parse(home).root) throw new Error('Invalid Pinokio home.');
  return home;
}

function buildEnvironment({ appDirectory, platform = process.platform, environment = process.env,
  explicit = {}, recordEnv = {}, getTemp = darwinTemp } = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const home = pinokioHome(appDirectory, platform);
  const normalize = (value) => {
    const text = String(value).replace(/\\/g, '/').replace(/\/$/, '');
    return win ? text.toLowerCase() : text;
  };
  const homes = [home];
  // Also recognize the canonical home when Pinokio is reached via a symlink.
  if (platform === process.platform && fs.existsSync(home)) {
    homes.push(fs.realpathSync(home));
    const actual = fs.realpathSync(appDirectory);
    if (normalize(p.dirname(actual)) !== normalize(p.join(homes[1], 'api'))) {
      throw new Error('The Pinokio app must be directly inside its home/api folder.');
    }
  }
  const includesPath = (value, directory) => {
    const text = normalize(value), prefix = normalize(directory);
    let index = text.indexOf(prefix);
    while (index !== -1) {
      if (index + prefix.length === text.length || '/;:\"\' \n\r'.includes(text[index + prefix.length])) return true;
      index = text.indexOf(prefix, index + 1);
    }
    return false;
  };
  const inHome = (value) => homes.some((directory) => includesPath(value, directory));
  const allowedRoots = [p.join(appDirectory, 'app', 'astrid'), p.join(appDirectory, 'app', 'editor')];
  if (homes.length > 1) allowedRoots.push(...allowedRoots.map((directory) => p.join(homes[1], p.relative(home, directory))));
  const deliberatePath = (value) => allowedRoots.some((directory) => {
    const text = normalize(value), root = normalize(directory);
    return text === root || text.startsWith(`${root}/`);
  });
  const cleanPath = (value, deliberate) => String(value).split(win ? ';' : ':').filter((entry) => {
    // Resolve relative entries against the app: ./node_modules/.bin is also
    // Pinokio-owned even though its text doesn't contain the home directory.
    const resolved = p.resolve(appDirectory, entry.replace(/^"|"$/g, ''));
    return entry && (!inHome(resolved) || (deliberate && deliberatePath(resolved)));
  }).join(win ? ';' : ':');
  const cleanPsModulePath = (value) => String(value).split(';').filter((entry) => {
    const text = entry.toLowerCase();
    return entry && !text.includes('powershell_7') && !text.includes('microsoft.powershell_') && !(text.includes('\\powershell\\modules') && !text.includes('windowspowershell'));
  }).join(';');
  const env = {};
  const allowed = new Set([...BASE, ...(win ? WINDOWS : platform === 'linux' ? LINUX : [])]);
  for (const [key, value] of Object.entries(environment)) {
    const name = win ? key.toUpperCase() : key;
    if (!allowed.has(name) && !PROXIES.includes(key)) continue;
    if (name === 'TMPDIR' || name === 'TMP' || name === 'TEMP') continue;
    if (name === 'PATH') env.PATH = cleanPath(value, false);
    else if (win && name === 'PSMODULEPATH') env.PSMODULEPATH = cleanPsModulePath(value);
    else if (!inHome(value)) env[allowed.has(name) ? name : key] = value;
  }
  if (platform === 'darwin') {
    const temp = getTemp();
    if (temp && !inHome(temp)) env.TMPDIR = temp;
  } else if (win) {
    const local = Object.entries(env).find(([key]) => key.toUpperCase() === 'LOCALAPPDATA')?.[1];
    if (local) env.TEMP = env.TMP = p.join(local, 'Temp');
  }
  for (const additions of [{ ASTRID_INSTALL_MANAGED_BY: 'pinokio' }, explicit, recordEnv]) {
    for (const [key, value] of Object.entries(additions)) {
      if (key.toUpperCase() === 'PATH') {
        for (const prior of Object.keys(env)) if (prior.toUpperCase() === 'PATH') delete env[prior];
        env.PATH = cleanPath(value, true);
      } else if (win && key.toUpperCase() === 'PSMODULEPATH') {
        for (const prior of Object.keys(env)) if (prior.toUpperCase() === 'PSMODULEPATH') delete env[prior];
        env.PSMODULEPATH = cleanPsModulePath(value);
      } else {
        if (inHome(value) && !deliberatePath(value)) continue;
        // Windows environment names are case-insensitive.
        if (win) for (const prior of Object.keys(env)) if (prior.toUpperCase() === key.toUpperCase()) delete env[prior];
        env[key] = value;
      }
    }
  }
  return env;
}

function darwinTemp() {
  const result = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', env: {} });
  return result.status === 0 ? result.stdout.trim() : '';
}

module.exports = { buildEnvironment, pinokioHome };
