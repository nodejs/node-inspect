'use strict';
const tap = require('tap');

const startCLI = require('./start-cli');

tap.test('stepping through breakpoints', (t) => {
  const cli = startCLI(['examples/break.js']);

  function onFatal(error) {
    cli.quit();
    throw error;
  }

  return cli.waitFor(/break/)
    .then(() => cli.waitForPrompt())
    .then(() => {
      t.match(cli.output, 'break in examples/break.js:1',
        'pauses in the first line of the script');
      t.match(cli.output,
        '> 1 (function (exports, require, module, __filename, __dirname) { const x = 10;',
        'shows the source and marks the current line');
    })
    .then(() => cli.stepCommand('n'))
    .then(() => {
      t.match(cli.output, 'break in examples/break.js:2',
        'pauses in next line of the script');
      t.match(cli.output,
        '> 2 let name = \'World\';',
        'marks the 2nd line');
    })
    .then(() => cli.stepCommand('next'))
    .then(() => {
      t.match(cli.output, 'break in examples/break.js:3',
        'pauses in next line of the script');
      t.match(cli.output,
        '> 3 name = \'Robin\';',
        'marks the 3nd line');
    })
    .then(() => cli.stepCommand('cont'))
    .then(() => {
      t.match(cli.output, 'break in examples/break.js:10',
        'pauses on the next breakpoint');
      t.match(cli.output,
        '>10 debugger;',
        'marks the debugger line');
    })
    .then(() => cli.command('sb("break.js", 6)'))
    .then(() => cli.command('sb("otherFunction()")'))
    .then(() => cli.stepCommand('s'))
    .then(() => cli.stepCommand(''))
    .then(() => {
      t.match(cli.output, 'break in timers.js',
        'entered timers.js');
    })
    .then(() => cli.stepCommand('cont'))
    .then(() => {
      t.match(cli.output, 'break in examples/break.js:6',
        'found breakpoint we set above');
    })
    .then(() => cli.stepCommand(''))
    .then(() => {
      t.match(cli.output, 'debugCommand in examples/break.js:14',
        'found function breakpoint we set above');
    })
    .then(() => cli.quit())
    .then(null, onFatal);
});
