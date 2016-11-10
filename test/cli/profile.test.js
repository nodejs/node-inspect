'use strict';
const { test } = require('tap');

const startCLI = require('./start-cli');

test('profiles', (t) => {
  const cli = startCLI(['examples/empty.js']);

  function onFatal(error) {
    cli.quit();
    throw error;
  }

  return cli.waitFor(/break/)
    .then(() => cli.waitForPrompt())
    .then(() => cli.command('exec console.profile()'))
    .then(() => {
      t.match(cli.output, 'undefined');
    })
    .then(() => cli.command('exec console.profileEnd()'))
    .then(() => {
      t.match(cli.output, 'undefined');
    })
    .then(() => cli.quit())
    .then(null, onFatal);
});
