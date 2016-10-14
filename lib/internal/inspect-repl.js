/*
 * Copyright Node.js contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
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
