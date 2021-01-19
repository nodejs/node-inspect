'use strict';

const Path = require('path');

const { test } = require('tap');

const startCLI = require('./start-cli');

test('breakpoint inside node internal module', (t) => {
  const script = Path.join('examples', 'internal-modules.js');
  const cli = startCLI([script]);

  function onFatal(error) {
    cli.quit();
    throw error;
  }

  return cli.waitForInitialBreak()
    .then(() => cli.waitForPrompt())
    .then(() => cli.stepCommand('n'))
    .then(() => cli.stepCommand('s'))
    .then(() => {
      t.notMatch(cli.breakInfo.filename, /^node:/);
    })
    .then(() => cli.quit())
    .then(null, onFatal);
});
