'use strict';
const Repl = require('repl');
const vm = require('vm');

function toCallback(promise, callback) {
  function forward(...args) {
    process.nextTick(() => callback(...args));
  }
  promise.then(forward.bind(null, null), forward);
}

function startRepl(inspector) {
  let repl; // forward declaration
  let lastCommand;

  function prepareControlCode(input) {
    if (input === '\n') return lastCommand;
    // exec process.title => exec("process.title");
    const match = input.match(/^\s*exec\s+([^\n]*)/);
    if (match) {
      lastCommand = `exec(${JSON.stringify(match[1])})`;
    } else {
      lastCommand = input;
    }
    return lastCommand;
  }

  function controlEval(input, context, filename, callback) {
    try {
      const code = prepareControlCode(input);
      const result = vm.runInContext(code, context, filename);

      if (result && typeof result.then === 'function') {
        toCallback(result, callback);
        return;
      }
      callback(null, result);
    } catch (e) {
      callback(e);
    }
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
