'use strict';
const { test } = require('tap');

const PKG = require('../../package.json');

const startCLI = require('./start-cli');

const isEmbedded = process.env.USE_EMBEDDED_NODE_INSPECT === '1';

test('retrieve CLI version', (t) => {
  const cli = startCLI(['--version']);

  function onFatal(error) {
    cli.quit();
    throw error;
  }

  return cli.waitForExit()
    .then(() => {
      if (isEmbedded) {
        t.include(cli.output, '(bundled)');
      } else {
        t.equal(cli.output, `v${PKG.version}\n`);
      }
    })
    .then(null, onFatal);
});
