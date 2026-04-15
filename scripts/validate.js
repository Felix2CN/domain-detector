const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const jsFiles = ['background.js', 'popup.js', 'scripts/build_china_ip.js'];
const jsonFiles = ['manifest.json'];
const textFilesNoBom = ['manifest.json', 'popup.html', 'popup.js', 'background.js', 'README.md', 'scripts/validate.js'];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readUtf8(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function checkNoBom(file) {
  const buf = fs.readFileSync(path.join(root, file));
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  assert(!hasBom, `${file} contains a UTF-8 BOM`);
}

function checkJson(file) {
  JSON.parse(readUtf8(file));
}

function checkScriptSyntax(file) {
  const source = readUtf8(file);
  new vm.Script(source, { filename: file });
}

function main() {
  textFilesNoBom.forEach(checkNoBom);
  jsonFiles.forEach(checkJson);
  jsFiles.forEach(checkScriptSyntax);
  console.log('Validation passed');
}

main();
