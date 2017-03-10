'use strict';
const Path = require('path');

const { test } = require('tap');

const startCLI = require('./start-cli');

var brkLine = 1;
if (process.platform == 'aix') {
  brkLine = 2;
}

test('break on (uncaught) exceptions', (t) => {
  const script = Path.join('examples', 'exceptions.js');
  const cli = startCLI([script]);

  function onFatal(error) {
    cli.quit();
    throw error;
  }

  return cli.waitFor(/break/)
    .then(() => cli.waitForPrompt())
    .then(() => {
      t.match(cli.output, `break in ${script}:${brkLine}`);
    })
    // making sure it will die by default:
    .then(() => cli.command('c'))
    .then(() => cli.waitFor(/disconnect/))

    // Next run: With `breakOnException` it pauses in both places
    .then(() => cli.stepCommand('r'))
    .then(() => {
      t.match(cli.output, `break in ${script}:${brkLine}`);
    })
    .then(() => cli.command('breakOnException'))
    .then(() => cli.stepCommand('c'))
    .then(() => {
      t.match(cli.output, `exception in ${script}:4`);
    })
    .then(() => cli.stepCommand('c'))
    .then(() => {
      t.match(cli.output, `exception in ${script}:10`);
    })

    // Next run: With `breakOnUncaught` it only pauses on the 2nd exception
    .then(() => cli.command('breakOnUncaught'))
    .then(() => cli.stepCommand('r')) // also, the setting survives the restart
    .then(() => {
      t.match(cli.output, `break in ${script}:${brkLine}`);
    })
    .then(() => cli.stepCommand('c'))
    .then(() => {
      t.match(cli.output, `exception in ${script}:10`);
    })

    // Next run: Back to the initial state! It should die again.
    .then(() => cli.command('breakOnNone'))
    .then(() => cli.stepCommand('r'))
    .then(() => {
      t.match(cli.output, `break in ${script}:${brkLine}`);
    })
    .then(() => cli.command('c'))
    .then(() => cli.waitFor(/disconnect/))

    .then(() => cli.quit())
    .then(null, onFatal);
});
