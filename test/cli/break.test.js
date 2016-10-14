'use strict';
const tap = require('tap');

const startCLI = require('./start-cli');

tap.test('break on first line', (t) => {
  const cli = startCLI(['examples/empty.js']);

  function onFatal(error) {
    cli.quit();
    throw error;
  }

  return cli.waitFor(/break/)
    .then(() => cli.waitForPrompt())
    .then(() => {
      t.match(cli.output, 'break in examples/empty.js:2',
        'pauses in the first line of the script');
      t.match(cli.output, '> 2 });',
        'shows the source and marks the current line');
    })
    .then(() => cli.quit())
    .then(null, onFatal);
});
