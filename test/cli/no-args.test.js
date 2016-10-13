'use strict';
const tap = require('tap');

const startCLI = require('./start-cli');

tap.test('launch CLI w/o args', (t) => {
  const cli = startCLI([]);
  return cli.quit()
    .then((code) => {
      t.equal(code, 1, 'exits with non-zero exit code');
      t.match(cli.flushOutput(), /^Usage:/, 'Prints usage info');
    });
});
