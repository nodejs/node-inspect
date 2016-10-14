'use strict';
const Repl = require('repl');

function startRepl(inspector) {
  let repl; // forward declaration

  function controlEval(code, ctx, file, cb) {
    cb(new Error('Not implemented'));
  }

  const replOptions = {
    prompt: 'debug> ',
    input: inspector.stdin,
    output: inspector.stdout,
    eval: controlEval,
    useGlobal: false,
    ignoreUndefined: true,
  };
  repl = Repl.start(replOptions); // eslint-disable-line prefer-const

  return repl;
}
module.exports = startRepl;
