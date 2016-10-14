'use strict';
const tap = require('tap');

const startCLI = require('./start-cli');

tap.test('examples/empty.js', (t) => {
  const cli = startCLI(['examples/empty.js']);
  return cli.waitForPrompt()
    .then(() => cli.quit())
    .then((code) => {
      t.match(cli.output, 'debug>', 'prints a prompt');
      t.match(cli.output, '< Debugger listening on port 9229', 'forwards child output');
      t.equal(code, 0, 'exits with success');
    });
});
