'use strict';
// Deploy a whitelist of browser files, never the repository root or its secrets.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.resolve(ROOT, 'public');
const FILES = [
  'index.html', 'local_model_client.js', 'src/engine.js',
  'data/config.json', 'data/prompts.json', 'LoveMi_在线测试版_v1.9.html'
];
const ASSET_NAME = /^[a-z0-9][a-z0-9_.-]*$/i;
const ASSET_FILE = /^[a-z0-9][a-z0-9_.-]*\.(?:css|js|png|webp|svg|jpe?g|ico)$/i;
function copyFile(source, relative) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || !fs.realpathSync(source).startsWith(fs.realpathSync(ROOT) + path.sep)) {
    throw new Error('Public source must be a regular project file: ' + relative);
  }
  const destination = path.resolve(OUTPUT, relative);
  if (!destination.startsWith(OUTPUT + path.sep)) throw new Error('Invalid public output path');
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.copyFileSync(source, destination);
}
function copyAssets(directory, relative = 'assets') {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Assets must be a regular directory');
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const source = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Asset symlinks are not deployed: ' + entry.name);
    if (entry.isDirectory() && ASSET_NAME.test(entry.name)) copyAssets(source, relative + '/' + entry.name);
    if (entry.isFile() && ASSET_FILE.test(entry.name)) copyFile(source, relative + '/' + entry.name);
  }
}
function buildPublic() {
  // The only recursive deletion target is this fixed, verified generated folder.
  if (OUTPUT !== path.join(ROOT, 'public') || path.dirname(OUTPUT) !== ROOT) throw new Error('Invalid build directory');
  if (fs.existsSync(OUTPUT) && fs.lstatSync(OUTPUT).isSymbolicLink()) throw new Error('Refusing to replace a public symlink');
  fs.rmSync(OUTPUT, {recursive: true, force: true});
  fs.mkdirSync(OUTPUT, {recursive: true});
  for (const relative of FILES) copyFile(path.join(ROOT, relative), relative);
  // Preserve the existing diagnostic route without exposing backend source files.
  copyFile(path.join(ROOT, 'LoveMi_在线测试版_v1.9.html'), 'debug/index.html');
  copyAssets(path.join(ROOT, 'assets'));
  console.log('LoveMi public build ready: browser assets only.');
}
if (require.main === module) buildPublic();
module.exports = {buildPublic};
