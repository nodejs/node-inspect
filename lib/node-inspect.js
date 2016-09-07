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
'use strict'; /* eslint no-underscore-dangle: 0 */
// Our equivalent of '_debugger' in node itthis
const assert = require('assert');
const crypto = require('crypto');
const events = require('events');
const http = require('http');
const Repl = require('repl');
const spawn = require('child_process').spawn;
const path = require('path');
const util = require('util');
const vm = require('vm');

const debuglog = util.debuglog('inspect');

const NO_FRAME = -1;

const kOpCodeContinuation = 0x0;
const kOpCodeText = 0x1;
const kOpCodeBinary = 0x2;
const kOpCodeClose = 0x8;
const kOpCodePing = 0x9;
const kOpCodePong = 0xA;

const kFinalBit = 0x80;
const kReserved1Bit = 0x40;
const kReserved2Bit = 0x20;
const kReserved3Bit = 0x10;
const kOpCodeMask = 0xF;
const kMaskBit = 0x80;
const kPayloadLengthMask = 0x7F;

const kMaxSingleBytePayloadLength = 125;
const kMaxTwoBytePayloadLength = 0xFFFF;
const kTwoBytePayloadLengthField = 126;
const kEightBytePayloadLengthField = 127;
const kMaskingKeyWidthInBytes = 4;

exports.port = process.debugPort;

function ignoreError() {}

function encodeFrameHybi17(payload) {
  const dataLength = payload.length;

  let singleByteLength;
  let additionalLength;
  if (dataLength > kMaxTwoBytePayloadLength) {
    singleByteLength = kEightBytePayloadLengthField;
    additionalLength = new Buffer(8);
    let remaining = dataLength;
    for (let i = 0; i < 8; ++i) {
      additionalLength[7 - i] = remaining & 0xFF;
      remaining >>= 8;
    }
  } else if (dataLength > kMaxSingleBytePayloadLength) {
    singleByteLength = kTwoBytePayloadLengthField;
    additionalLength = new Buffer(2);
    additionalLength[0] = (dataLength & 0xFF00) >> 8;
    additionalLength[1] = dataLength & 0xFF;
  } else {
    additionalLength = new Buffer(0);
    singleByteLength = dataLength;
  }

  const header = new Buffer([
    kFinalBit | kOpCodeText,
    kMaskBit | singleByteLength,
  ]);

  const mask = new Buffer(4);
  const masked = new Buffer(dataLength);
  for (let i = 0; i < dataLength; ++i) {
    masked[i] = payload[i] ^ mask[i % kMaskingKeyWidthInBytes];
  }

  return Buffer.concat([header, additionalLength, mask, masked]);
}

function decodeFrameHybi17(data) {
  const dataAvailable = data.length;
  const notComplete = { closed: false, payload: null, rest: data };
  let payloadOffset = 2;
  if ((dataAvailable - payloadOffset) < 0) return notComplete;

  const firstByte = data[0];
  const secondByte = data[1];

  const final = (firstByte & kFinalBit) !== 0;
  const reserved1 = (firstByte & kReserved1Bit) !== 0;
  const reserved2 = (firstByte & kReserved2Bit) !== 0;
  const reserved3 = (firstByte & kReserved3Bit) !== 0;
  const opCode = firstByte & kOpCodeMask;
  const masked = (secondByte & kMaskBit) !== 0;
  const compressed = reserved1;
  if (compressed) {
    throw new Error('Compressed frames not supported');
  }
  if (!final || reserved2 || reserved3) {
    throw new Error('Only compression extension is supported');
  }

  if (masked) {
    throw new Error('Masked server frame - not supported');
  }

  let closed = false;
  switch (opCode) {
    case kOpCodeClose:
      closed = true;
      break;
    case kOpCodeText:
      break;
    case kOpCodeBinary:        // We don't support binary frames yet.
    case kOpCodeContinuation:  // We don't support binary frames yet.
    case kOpCodePing:          // We don't support binary frames yet.
    case kOpCodePong:          // We don't support binary frames yet.
    default:
      throw new Error(`Unsupported op code ${opCode}`);
  }

  let payloadLength = secondByte & kPayloadLengthMask;
  switch (payloadLength) {
    case kTwoBytePayloadLengthField:
      payloadOffset += 2;
      payloadLength = (data[2] << 8) + data[3];
      break;

    case kEightBytePayloadLengthField:
      payloadOffset += 8;
      payloadLength = 0;
      for (let i = 0; i < 8; ++i) {
        payloadLength <<= 8;
        payloadLength |= data[2 + i];
      }
      break;

    default:
      // Nothing. We already have the right size.
  }
  if ((dataAvailable - payloadOffset) < 0) return notComplete;

  const payloadEnd = payloadOffset + payloadLength;
  return {
    payload: data.slice(payloadOffset, payloadEnd),
    rest: data.slice(payloadEnd),
    closed,
  };
}

function isEmpty(obj) {
  return Object.keys(obj).length === 0;
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

function getRelativePath(filename) {
  const dir = `${path.resolve()}/`;

  // Change path to relative, if possible
  if (filename.indexOf(dir) === 0) {
    return filename.slice(dir.length);
  }
  return filename;
}

function formatPreview({ properties, subtype }) {
  const object = properties.reduce((obj, { name, value }) => {
    obj[name] = value;
    return obj;
  }, subtype === 'array' ? [] : {});
  return object;
}

function extractErrorMessage(stack) {
  if (!stack) return '<unknown>';
  const m = stack.match(/^\w+: ([^\n]+)/);
  return m ? m[1] : stack;
}

function formatValue({ result, wasThrown }) {
  const { className, description, preview, type, value } = result;
  if (wasThrown) {
    const err = new Error(extractErrorMessage(description));
    err.stack = description;
    Object.defineProperty(err, 'name', { value: className });
    return err;
  }
  if (type === 'object') {
    if (preview && preview.properties) {
      return formatPreview(preview);
    }
    return description;
  }
  return value;
}

function toCallback(promise, callback) {
  promise
    // TODO: this will swallow sync exceptions in callback
    .then(callback.bind(null, null), callback);
}

class Client extends events.EventEmitter {
  constructor() {
    super();
    this._http = null;
    this._open = false;
    this._lastId = 0;
    this._socket = null;
    this._pending = {};
    this._unprocessed = new Buffer(0);

    this.handleChunk = this._handleChunk.bind(this);
  }

  _handleChunk(chunk) {
    this._unprocessed = Buffer.concat([this._unprocessed, chunk]);

    while (this._unprocessed.length > 2) {
      const { payload, rest } = decodeFrameHybi17(this._unprocessed);
      this._unprocessed = rest;
      if (payload === null) break;

      debuglog('< %s', payload);
      const { id, method, params, result, error } = JSON.parse(payload.toString());
      if (id) {
        const handler = this._pending[id];
        if (handler) {
          delete this._pending[id];
          handler(error, result);
        }
      } else if (method) {
        this.emit('debugEvent', method, params);
        this.emit(method, params);
      } else {
        throw new Error(`Unsupported response: ${payload.toString()}`);
      }
    }
  }

  destroy() {
    if (this._http) {
      this._http.destroy();
      this._http = null;
    }
  }

  callMethod(method, params) {
    return new Promise((resolve, reject) => {
      const data = { id: ++this._lastId, method, params };
      this._pending[data.id] = (error, result) => {
        if (error) reject(error);
        else resolve(isEmpty(result) ? undefined : result);
      };
      const json = JSON.stringify(data);
      debuglog('> %s', json);
      this._socket.write(encodeFrameHybi17(new Buffer(json)));
    });
  }

  connect(port, host) {
    const key1 = crypto.randomBytes(16).toString('base64');

    const httpReq = this._http = http.request({
      host, port,
      path: '/node',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key1,
      },
    });
    httpReq.on('error', e => {
      this.emit('error', e);
    });
    httpReq.on('response', httpRes => {
      if (httpRes.statusCode >= 400) {
        httpRes.pipe(process.stderr);
      } else {
        httpRes.pipe(process.stderr);
      }
    });

    const handshakeListener = (res, socket) => {
      // TODO: we *could* validate res.headers[sec-websocket-accept]

      this._socket = socket;
      socket.on('data', this.handleChunk);

      Promise.all([
        this.callMethod('Log.enable').then(null, ignoreError),
        this.callMethod('Runtime.enable'),
        this.callMethod('Page.enable').then(null, ignoreError),
        this.callMethod('Page.getResourceTree').then(null, ignoreError),
        this.callMethod('Debugger.enable'),
        this.callMethod('Debugger.setPauseOnExceptions', { state: 'none' }),
        this.callMethod('Debugger.setAsyncCallStackDepth', { maxDepth: 0 }),
        this.callMethod('Profiler.enable'),
        this.callMethod('Profiler.setSamplingInterval', { interval: 100 }),
        this.callMethod('Debugger.setBlackboxPatterns', { patterns: [] }),
        this.callMethod('Runtime.run'),
      ]).then(() => {
        this.emit('ready');
      }, error => {
        this.emit('error', error);
      });
    };
    httpReq.on('upgrade', handshakeListener);
    httpReq.end();
  }
}

const SHORTCUTS = {
  run: 'r',
  cont: 'c',
  next: 'n',
  step: 's',
  out: 'o',
  backtrace: 'bt',
  setBreakpoint: 'sb',
  clearBreakpoint: 'cb',
  pause_: 'pause',
};

function createAgentProxy(domain, inspector) {
  const agent = new events.EventEmitter();

  return new Proxy(agent, {
    get(target, name) {
      if (name in target) return target[name];
      return function callVirtualMethod(params) {
        return inspector.client.callMethod(`${domain}.${name}`, params);
      };
    },
  });
}

function createCommandContext(inspector) {
  const { Debugger, repl, stdout } = inspector;

  let currentSourceLocation = undefined;
  let currentFrame = undefined;

  const scripts = {};
  const watchedExpressions = [];

  // Clear current line
  function clearline() {
    if (stdout.isTTY) {
      stdout.cursorTo(0);
      stdout.clearLine(1);
    } else {
      stdout.write('\b');
    }
  }

  // Print text to output stream
  function print(text, oneline = false) {
    if (inspector.killed) return;
    clearline();

    stdout.write(typeof text === 'string' ? text : util.inspect(text));

    if (oneline !== true) {
      stdout.write('\n');
    }
  }

  const ctx = {
    debugEval(code) {
      // Repl asked for scope variables
      if (code === '.scope') {
        return Promise.reject('client.reqScopes not implemented');
      }

      const params = {
        callFrameId: currentFrame,
        expression: code,
        objectGroup: 'node-inspect',
        generatePreview: true,
      };

      return Debugger.evaluateOnCallFrame(params)
          .then(formatValue);
    },

    exec(code) {
      return ctx.debugEval(code);
    },

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

    // List source code
    list(delta = 5) {
      const { scriptId, lineNumber, columnNumber } = currentSourceLocation;
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

            const isBreakpoint = false; // TODO: show breakpoints
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
    },

    watch(expr) {
      watchedExpressions.push(expr);
    },

    unwatch(expr) {
      const index = watchedExpressions.indexOf(expr);

      // Unwatch by expression
      // or
      // Unwatch by watcher number
      watchedExpressions.splice(index !== -1 ? index : +expr, 1);
    },

    watchers(verbose = false) {
      if (!watchedExpressions.length) {
        return Promise.resolve();
      }

      const inspectValue = expr =>
        this.debugEval(expr)
          .catch(error => `<${error.message}>`);

      return Promise.all(watchedExpressions.map(inspectValue))
        .then(values => {
          if (verbose) print('Watchers:');

          watchedExpressions.forEach((expr, idx) => {
            const prefix = leftPad(idx, ' ', watchedExpressions.length - 1);
            print(`${prefix}: ${expr} = ${values[idx]}`);
          });

          if (verbose) print('');
        });
    },
  };

  Debugger.on('paused', ({ callFrames, reason /* , hitBreakpoints */ }) => {
    // Save execution context's data
    const topFrame = callFrames[0];
    const { scriptId, lineNumber } = currentSourceLocation = topFrame.location;
    currentFrame = topFrame.callFrameId;

    const script = scripts[scriptId];
    const scriptUrl = script ? getRelativePath(script.url) : '[unknown]';
    print(`${reason} in ${scriptUrl}:${lineNumber + 1}`);

    ctx.watchers(true)
      .then(() => ctx.list(2))
      .then(null, console.error)
      .then(() => repl.displayPrompt());
  });

  Debugger.on('scriptParsed', ({ scriptId, url }) => {
    if (url) {
      scripts[scriptId] = { url };
    }
  });

  return ctx;
}

// This class is the repl-enabled debugger interface which is invoked on
// "node-inspect"
class Inspector {
  constructor(stdin, stdout, args) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.args = args;

    this.scripts = {};

    ['Debugger', 'Runtime'].forEach(domain => {
      this[domain] = createAgentProxy(domain, this);
    });

    // Two eval modes are available: controlEval and debugEval
    // But controlEval is used by default
    const opts = {
      prompt: 'debug> ',
      input: this.stdin,
      output: this.stdout,
      eval: (code, ctx, file, cb) => this.controlEval(code, ctx, file, cb),
      useGlobal: false,
      ignoreUndefined: true,
    };
    if (parseInt(process.env.NODE_NO_READLINE, 10)) {
      opts.terminal = false;
    } else if (parseInt(process.env.NODE_FORCE_READLINE, 10)) {
      opts.terminal = true;

      // Emulate Ctrl+C if we're emulating terminal
      if (!this.stdout.isTTY) {
        process.on('SIGINT', () => {
          this.repl.rli.emit('SIGINT');
        });
      }
    }
    if (parseInt(process.env.NODE_DISABLE_COLORS, 10)) {
      opts.useColors = false;
    }

    this.repl = Repl.start(opts);

    // Do not print useless warning
    Repl._builtinLibs.splice(Repl._builtinLibs.indexOf('repl'), 1);

    // Kill child process when main process dies
    this.repl.on('exit', () => {
      process.exit(0);
    });

    // Handle all possible exits
    process.on('exit', () => this.killChild());
    process.once('SIGTERM', process.exit.bind(process, 0));
    process.once('SIGHUP', process.exit.bind(process, 0));

    const commandCtx = createCommandContext(this);

    const defineProperty = (key, protoKey) => {
      const desc = Object.assign(Object.getOwnPropertyDescriptor(commandCtx, protoKey), {
        enumerable: true,
        configurable: false,
      });
      Object.defineProperty(this.repl.context, key, desc);

      if (SHORTCUTS[key]) {
        defineProperty(SHORTCUTS[key], key);
      }
    };

    // Copy all prototype methods in repl context
    // Setup them as getters if possible
    Object.getOwnPropertyNames(commandCtx)
      .forEach(prop => defineProperty(prop, prop));

    this.client = null;

    this.killed = false;
    this.waiting = null;
    this.paused = 0;
    this.context = this.repl.context;
    this.history = { debug: [], control: [] };
    this.breakpoints = [];
    this._watchers = [];

    // Run script automatically
    this.pause();
    setImmediate(() => {
      this.run();
      this.resume(true);
    });
  }

  handlePaused({ callFrames /* , reason, hitBreakpoints */ }) {
    // this.pause();

    // Save execution context's data
    const topFrame = callFrames[0];
    // const { scriptId, lineNumber } = this.client.currentSourceLocation = topFrame.location;
    this.client.currentFrame = topFrame.callFrameId;

    // const script = this.scripts[scriptId];
    // const scriptUrl = script ? getRelativePath(script.url) : '[unknown]';
    // this.print(`${reason} in ${scriptUrl}:${lineNumber + 1}`);

    // this.watchers(true)
    //   .then(() => this.list(2))
    //   .then(() => {
    //     this.resume();
    //   }, this.error.bind(this));
  }

  controlEval(code, context, filename, callback) {
    /* eslint no-param-reassign: 0 */
    try {
      // Repeat last command if empty line are going to be evaluated
      if (code === '\n') {
        code = this._lastCommand;
      } else {
        this._lastCommand = code;
      }

      // exec process.title => exec("process.title");
      const match = code.match(/^\s*exec\s+([^\n]*)/);
      if (match) {
        code = `exec(${JSON.stringify(match[1])})`;
      }

      const result = vm.runInContext(code, context, filename);

      if (result && typeof result.then === 'function') {
        toCallback(result, callback);
        return;
      }

      // Repl should not ask for next command
      // if current one was asynchronous.
      if (this.paused === 0) {
        callback(null, result);
        return;
      }

      // Add a callback for asynchronous command
      // (it will be automatically invoked by .resume() method
      this.waiting = function waiting() {
        callback(null, result);
      };
    } catch (e) {
      callback(e);
    }
  }

  // Clear current line
  clearline() {
    if (this.stdout.isTTY) {
      this.stdout.cursorTo(0);
      this.stdout.clearLine(1);
    } else {
      this.stdout.write('\b');
    }
  }

  // Print text to output stream
  print(text, oneline = false) {
    if (this.killed) return;
    this.clearline();

    this.stdout.write(typeof text === 'string' ? text : util.inspect(text));

    if (oneline !== true) {
      this.stdout.write('\n');
    }
  }

  // Format and print text from child process
  childPrint(text) {
    this.print(
      text.toString()
        .split(/\r\n|\r|\n/g)
        .filter(chunk => !!chunk)
        .map(chunk => `< ${chunk}`)
        .join('\n')
    );
    if (!this.paused) {
      this.repl.displayPrompt(true);
    }
  }

  // Errors formatting
  error(text) {
    this.print(text);
    this.resume();
  }


  // Stream control


  pause() {
    if (this.killed || this.paused++ > 0) return this;
    this.repl.rli.pause();
    this.stdin.pause();
    return this;
  }

  resume(silent) {
    if (this.killed || this.paused === 0 || --this.paused !== 0) return this;
    this.repl.rli.resume();
    if (silent !== true) {
      this.repl.displayPrompt();
    }
    this.stdin.resume();

    if (this.waiting) {
      this.waiting();
      this.waiting = null;
    }
    return this;
  }


  // Commands


  // // Print help message
  // help() {
  //   this.print(helpMessage);
  // }


  // Run script
  run(callback) {
    if (this.child) {
      this.error('App is already running... Try `restart` instead');
      if (callback) callback(true);
    } else {
      this.trySpawn(callback);
    }
  }


  // Quit
  quit() {
    this.killChild();
    process.exit(0);
  }

  // Kills child process
  killChild() {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }

    if (this.client) {
      // Save breakpoints
      this.breakpoints = this.client.breakpoints;

      this.client.destroy();
      this.client = null;
    }
  }

  handleScriptParsed({ scriptId, url }) {
    if (url) {
      this.scripts[scriptId] = { url };
    }
  }

  // Spawns child process (and restores breakpoints)
  trySpawn(cb) {
    const breakpoints = this.breakpoints || [];
    let port = exports.port;
    let host = '127.0.0.1';
    let childArgs = this.args;

    this.killChild();
    assert(!this.child);

    let isRemote = false;
    if (this.args.length === 3) {
      const match = this.args[2].match(/^([^:]+):(\d+)$/);

      if (match) {
        // Connecting to remote debugger
        // `node debug localhost:5858`
        host = match[1];
        port = parseInt(match[2], 10);
        isRemote = true;
      }
    } else if (this.args.length === 4) {
      // `node debug -p pid`
      if (this.args[2] === '-p' && /^\d+$/.test(this.args[3])) {
        const pid = parseInt(this.args[2], 10);
        try {
          process._debugProcess(pid);
        } catch (e) {
          if (e.code === 'ESRCH') {
            console.error(`Target process: ${pid} doesn't exist.`);
            process.exit(1);
          }
          throw e;
        }
        isRemote = true;
      } else {
        const match = this.args[2].match(/^--port=(\d+)$/);
        if (match) {
          // Start debugger on custom port
          // `node debug --port=5858 app.js`
          port = parseInt(match[1], 10);
          childArgs = [`--inspect=${port}`, '--debug-brk'].concat(this.args.slice(3));
        }
      }
    }

    if (!isRemote) {
      // pipe stream into debugger
      this.child = spawn(process.execPath, childArgs);

      this.child.stdout.on('data', text => this.childPrint(text));
      this.child.stderr.on('data', text => this.childPrint(text));
    }

    this.pause();

    const client = this.client = new Client();
    let connectionAttempts = 0;

    client.on('debugEvent', (fullName, params) => {
      const [domain, name] = fullName.split('.');
      if (domain in this) {
        this[domain].emit(name, params);
      }
    });

    client.on('Debugger.scriptParsed', this.handleScriptParsed.bind(this));

    client.once('ready', () => {
      // Restore breakpoints
      breakpoints.forEach(bp => {
        this.print(`Restoring breakpoint ${bp.scriptReq}: ${bp.line}`);
        this.setBreakpoint(bp.scriptReq, bp.line, bp.condition, true);
      });

      client.on('close', () => {
        this.pause();
        this.print('program terminated');
        this.resume();
        this.client = null;
        this.killChild();
      });

      if (cb) cb();
      this.resume();
    });

    client.on('unhandledResponse', res => {
      this.pause();
      this.print(`\nunhandled res:${JSON.stringify(res)}`);
      this.resume();
    });

    client.on('Debugger.paused', res => {
      this.handlePaused(res);
    });

    const attemptConnect = () => {
      ++connectionAttempts;
      this.stdout.write('.');
      client.connect(port, host);
    };

    client.on('error', () => {
      // If it's failed to connect 10 times then print failed message
      if (connectionAttempts >= 10) {
        console.error(' failed to connect, please retry');
        process.exit(1);
      }
      setTimeout(attemptConnect, 500);
    });

    if (isRemote) {
      this.print(`connecting to ${host}:${port} ..`, true);
      attemptConnect();
    } else {
      this.child.stderr.once('data', () => {
        this.print(`connecting to ${host}:${port} ..`, true);
        setTimeout(attemptConnect, 300);
      });
    }
  }
}

exports.start = function start(argv = process.argv.slice(2),
                               stdin = process.stdin,
                               stdout = process.stdout) {
  if (argv.length < 1) {
    console.error('Usage: node-inspect script.js');
    console.error('       node-inspect <host>:<port>');
    process.exit(1);
  }

  const args = [`--inspect=${exports.port}`, '--debug-brk'].concat(argv);
  const inspector = new Inspector(stdin, stdout, args);

  stdin.resume();

  process.on('uncaughtException', e => {
    console.error('There was an internal error in node-inspect. ' +
                  'Please report this bug.');
    console.error(e.message);
    console.error(e.stack);
    if (inspector.child) inspector.child.kill();
    process.exit(1);
  });
};
