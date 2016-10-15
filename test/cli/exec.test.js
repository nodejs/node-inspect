'use strict';
const { test } = require('tap');

const startCLI = require('./start-cli');

test('examples/alive.js', (t) => {
  const cli = startCLI(['examples/alive.js']);

  function onFatal(error) {
    cli.quit();
    throw error;
  }

  return cli.waitFor(/break/)
    .then(() => cli.waitForPrompt())
    .then(() => cli.command('exec [typeof heartbeat, typeof process.exit]'))
    .then(() => {
      t.match(cli.output, '[ \'function\', \'function\' ]', 'works w/o paren');
    })
    .then(() => cli.command('exec("[typeof heartbeat, typeof process.exit]")'))
    .then(() => {
      t.match(cli.output, '[ \'function\', \'function\' ]', 'works w/ paren');
    })
    .then(() => cli.command('cont'))
    .then(() => cli.command('exec [typeof heartbeat, typeof process.exit]'))
    .then(() => {
      t.match(cli.output, '[ \'undefined\', \'function\' ]',
        'non-paused exec can see global but not module-scope values');
    })
    .then(() => cli.quit())
    .then(null, onFatal);
});
