'use strict';
const tap = require('tap');

const startCLI = require('./start-cli');

tap.test('examples/empty.js', (t) => {
  const cli = startCLI(['examples/empty.js']);
  return cli.quit()
    .then((code) => {
      t.equal(code, 0, 'exits with success');
    });
});
