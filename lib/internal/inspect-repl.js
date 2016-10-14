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
const Path = require('path');
const Repl = require('repl');
const vm = require('vm');

const NATIVES = process.binding('natives');

const SHORTCUTS = {
  cont: 'c',
  next: 'n',
  step: 's',
  out: 'o',
  // backtrace: 'bt',
  setBreakpoint: 'sb',
  // clearBreakpoint: 'cb',
  // pause_: 'pause',
  // run: 'r',
};

function getRelativePath(filename) {
  const dir = `${Path.resolve()}/`;

  // Change path to relative, if possible
  if (filename.indexOf(dir) === 0) {
    return filename.slice(dir.length);
  }
  return filename;
}

function toCallback(promise, callback) {
  function forward(...args) {
    process.nextTick(() => callback(...args));
  }
  promise.then(forward.bind(null, null), forward);
}

// Adds spaces and prefix to number
// maxN is a maximum number we should have space for
function leftPad(n, prefix, maxN) {
  const s = n.toString();
  const nchars = Math.max(2, String(maxN).length) + 1;
  const nspaces = nchars - s.length - 1;

  return prefix + ' '.repeat(nspaces) + s;
}

function markSourceColumn(sourceText, position, repl) {
  if (!sourceText) return '';

  const head = sourceText.slice(0, position);
  let tail = sourceText.slice(position);

  // Colourize char if stdout supports colours
  if (repl.useColors) {
    tail = tail.replace(/(.+?)([^\w]|$)/, '\u001b[32m$1\u001b[39m$2');
  }

  // Return source line with coloured char at `position`
  return [head, tail].join('');
}

function extractErrorMessage(stack) {
  if (!stack) return '<unknown>';
  const m = stack.match(/^\w+: ([^\n]+)/);
  return m ? m[1] : stack;
}

function convertResultToError(result) {
  const { className, description } = result;
  const err = new Error(extractErrorMessage(description));
  err.stack = description;
  Object.defineProperty(err, 'name', { value: className });
  return err;
}

function copyOwnProperties(target, source) {
  Object.getOwnPropertyNames(source).forEach((prop) => {
    Object.defineProperty(target, prop, Object.getOwnPropertyDescriptor(source, prop));
  });
}

function aliasProperties(target, mapping) {
  Object.keys(mapping).forEach((key) => {
    Object.defineProperty(target, mapping[key], Object.getOwnPropertyDescriptor(target, key));
  });
}

function createRepl(inspector) {
  const { Debugger } = inspector;

  let repl; // eslint-disable-line prefer-const
  let lastCommand;

  const knownScripts = {};
  const watchedExpressions = [];
  const knownBreakpoints = [];

  // let currentBacktrace;
  let selectedFrame;

  const print = inspector.print.bind(inspector);

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

  function watchers() {
    return Promise.resolve(watchedExpressions);
  }

  // List source code
  function list(delta = 5) {
    const { scriptId, lineNumber, columnNumber } = selectedFrame.location;
    const start = Math.max(1, lineNumber - delta + 1);
    const end = lineNumber + delta + 1;

    return Debugger.getScriptSource({ scriptId })
      .then(({ scriptSource }) => {
        const lines = scriptSource.split('\n');
        for (let i = start; i <= lines.length && i <= end; ++i) {
          const isCurrent = i === (lineNumber + 1);

          let lineText = lines[i - 1];
          if (isCurrent) {
            lineText = markSourceColumn(lineText, columnNumber, inspector.repl);
          }

          let isBreakpoint = false;
          knownBreakpoints.forEach(({ location }) => {
            if (location && location.scriptId === scriptId && (location.lineNumber + 1) === i) {
              isBreakpoint = true;
            }
          });

          let prefixChar = ' ';
          if (isCurrent) {
            prefixChar = '>';
          } else if (isBreakpoint) {
            prefixChar = '*';
          }
          print(`${leftPad(i, prefixChar, end)} ${lineText}`);
        }
      })
      .then(null, error => {
        print('You can\'t list source code right now');
        throw error;
      });
  }

  function handleBreakpointResolved({ breakpointId, location }) {
    const isExisting = knownBreakpoints.some(bp => {
      if (bp.breakpointId === breakpointId) {
        Object.assign(bp, { location });
        return true;
      }
      return false;
    });
    if (!isExisting) {
      knownBreakpoints.push({ breakpointId, location });
    }
  }

  function setBreakpoint(script, line, condition, silent) {
    function registerBreakpoint({ breakpointId, actualLocation }) {
      handleBreakpointResolved({ breakpointId, location: actualLocation });
      if (actualLocation && actualLocation.scriptId) {
        if (!silent) return list(5);
      } else {
        print(`Warning: script '${script}' was not loaded yet.`);
      }
      return undefined;
    }

    // setBreakpoint(): set breakpoint at current location
    if (script === undefined) {
      // TODO: assertIsPaused()
      return Debugger.setBreakpoint({ location: selectedFrame.location, condition })
        .then(registerBreakpoint);
    }

    // setBreakpoint(line): set breakpoint in current script at specific line
    if (line === undefined && typeof script === 'number') {
      // TODO: assertIsPaused()
      const location = Object.assign({}, selectedFrame.location, {
        lineNumber: script - 1,
      });
      return Debugger.setBreakpoint({ location, condition })
        .then(registerBreakpoint);
    }

    if (typeof script !== 'string') {
      throw new TypeError(`setBreakpoint() expects a string, got ${script}`);
    }

    // setBreakpoint('fn()'): Break when a function is called
    if (script.endsWith('()')) {
      // TODO: handle !currentFrame (~Runtime.evaluate)
      return Debugger.evaluateOnCallFrame({
        callFrameId: selectedFrame.callFrameId,
        expression: `debug(${script.slice(0, -2)})`,
        includeCommandLineAPI: true,
      }).then(({ result, wasThrown }) => {
        if (wasThrown) return convertResultToError(result);
        return undefined; // This breakpoint can't be removed the same way
      });
    }

    // setBreakpoint('scriptname')
    let scriptId = null;
    let ambiguous = false;
    if (knownScripts[script]) {
      scriptId = script;
    } else {
      for (const id of Object.keys(knownScripts)) {
        if (knownScripts[id].url && knownScripts[id].url.indexOf(script) !== -1) {
          if (scriptId !== null) {
            ambiguous = true;
          }
          scriptId = id;
        }
      }
    }

    if (ambiguous) {
      print('Script name is ambiguous');
      return undefined;
    }
    if (line <= 0) {
      print('Line should be a positive value');
      return undefined;
    }

    if (scriptId !== null) {
      const location = { scriptId, lineNumber: line - 1 };
      return Debugger.setBreakpoint({ location, condition })
        .then(registerBreakpoint);
    }

    const escapedPath = script.replace(/([/\\.?*()^${}|[\]])/g, '\\$1');
    const urlRegex = `^(.*[\\/\\\\])?${escapedPath}$`;

    return Debugger.setBreakpointByUrl({ urlRegex, lineNumber: line - 1, condition })
      .then(bp => {
        // TODO: handle bp.locations in case the regex matches existing files
        if (!bp.location) { // Fake it for now.
          Object.assign(bp, {
            actualLocation: { scriptUrl: `.*/${script}$`, lineNumber: line - 1 },
          });
        }
        return registerBreakpoint(bp);
      });
  }

  Debugger.on('paused', ({ callFrames, reason /* , hitBreakpoints */ }) => {
    // Save execution context's data
    // currentBacktrace = callFrames;
    selectedFrame = callFrames[0];
    const { scriptId, lineNumber } = selectedFrame.location;

    const script = knownScripts[scriptId];
    const scriptUrl = script ? getRelativePath(script.url) : '[unknown]';
    print(`${reason === 'other' ? 'break' : reason} in ${scriptUrl}:${lineNumber + 1}`);

    inspector.suspendReplWhile(() =>
      watchers(true)
        .then(() => list(2)));
  });

  Debugger.on('breakpointResolved', handleBreakpointResolved);

  Debugger.on('scriptParsed', (script) => {
    const { scriptId, url } = script;
    if (url) {
      knownScripts[scriptId] = Object.assign({
        isNative: url.replace('.js', '') in NATIVES || url === 'bootstrap_node.js',
      }, script);
    }
  });

  function initializeContext(context) {
    copyOwnProperties(context, {
      get cont() {
        return Debugger.resume();
      },

      get next() {
        return Debugger.stepOver();
      },

      get step() {
        return Debugger.stepInto();
      },

      get out() {
        return Debugger.stepOut();
      },

      get pause() {
        return Debugger.pause();
      },

      setBreakpoint,
      list,
    });
    aliasProperties(context, SHORTCUTS);
  }

  return function startRepl() {
    const replOptions = {
      prompt: 'debug> ',
      input: inspector.stdin,
      output: inspector.stdout,
      eval: controlEval,
      useGlobal: false,
      ignoreUndefined: true,
    };
    repl = Repl.start(replOptions); // eslint-disable-line prefer-const
    initializeContext(repl.context);
    repl.on('reset', initializeContext);
    return repl;
  };
}
module.exports = createRepl;
