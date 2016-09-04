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
// const crypto = require('crypto');
const events = require('events');
const http = require('http');
const repl = require('repl');
const spawn = require('child_process').spawn;
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

// Generate a Sec-WebSocket-* value
function createSecretKey() {
    // How many spaces will we be inserting?
    var numSpaces = 1 + Math.floor(Math.random() * 12);
    assert.ok(1 <= numSpaces && numSpaces <= 12);

    // What is the numerical value of our key?
    var keyVal = (Math.floor(
        Math.random() * (4294967295 / numSpaces)
    ) * numSpaces);

    // Our string starts with a string representation of our key
    var s = keyVal.toString();

    // Insert 'numChars' worth of noise in the character ranges
    // [0x21, 0x2f] (14 characters) and [0x3a, 0x7e] (68 characters)
    var numChars = 1 + Math.floor(Math.random() * 12);
    assert.ok(1 <= numChars && numChars <= 12);
    
    for (var i = 0; i < numChars; i++) {
        var pos = Math.floor(Math.random() * s.length + 1);

        var c = Math.floor(Math.random() * (14 + 68));
        c = (c <= 14) ?
            String.fromCharCode(c + 0x21) :
            String.fromCharCode((c - 14) + 0x3a);

        s = s.substring(0, pos) + c + s.substring(pos, s.length);
    }

    // We shoudln't have any spaces in our value until we insert them
    assert.equal(s.indexOf(' '), -1);

    // Insert 'numSpaces' worth of spaces
    for (var i = 0; i < numSpaces; i++) {
        var pos = Math.floor(Math.random() * (s.length - 1)) + 1;
        s = s.substring(0, pos) + ' ' + s.substring(pos, s.length);
    }

    assert.notEqual(s.charAt(0), ' ');
    assert.notEqual(s.charAt(s.length), ' ');

    return s;
}

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
    const toParse = Buffer.concat([this._unprocessed, chunk]);
    // this._unprocessed = toParse;
    const { payload, rest } = decodeFrameHybi17(toParse);
    this._unprocessed = rest;
    if (payload !== null) {
      debuglog('< %s', payload);
      const { id, method, params, result, error } = JSON.parse(payload.toString());
      if (id) {
        const handler = this._pending[id];
        if (handler) {
          delete this._pending[id];
          handler(error, result);
        }
      } else if (method) {
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
        else resolve(result);
      };
      const json = JSON.stringify(data);
      debuglog('> %s', json);
      this._socket.write(encodeFrameHybi17(new Buffer(json)));
    });
  }

  connect(port, host) {
    const key1 = createSecretKey();

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
        console.error('Server rejected request:');
        httpRes.pipe(process.stderr);
      } else {
        console.error('Unexpected response from server:', httpRes.statusCode);
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

// This class is the repl-enabled debugger interface which is invoked on
// "node-inspect"
class Inspector {
  constructor(stdin, stdout, args) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.args = args;

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

    this.repl = repl.start(opts);

    // Do not print useless warning
    repl._builtinLibs.splice(repl._builtinLibs.indexOf('repl'), 1);

    // Kill child process when main process dies
    this.repl.on('exit', () => {
      process.exit(0);
    });

    // Handle all possible exits
    process.on('exit', () => this.killChild());
    process.once('SIGTERM', process.exit.bind(process, 0));
    process.once('SIGHUP', process.exit.bind(process, 0));

    const proto = Inspector.prototype;
    const ignored = ['pause', 'resume', 'exitRepl', 'handlePaused',
                     'requireConnection', 'killChild', 'trySpawn',
                     'controlEval', 'debugEval', 'print', 'childPrint',
                     'clearline'];
    const shortcut = {
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

    const defineProperty = (key, protoKey) => {
      // Check arity
      const fn = proto[protoKey].bind(this);

      if (proto[protoKey].length === 0) {
        Object.defineProperty(this.repl.context, key, {
          get: fn,
          enumerable: true,
          configurable: false,
        });
      } else {
        this.repl.context[key] = fn;
      }

      if (shortcut[key]) {
        defineProperty(shortcut[key], key);
      }
    };

    // Copy all prototype methods in repl context
    // Setup them as getters if possible
    Object.getOwnPropertyNames(proto)
      .filter(prop => !ignored.includes(prop))
      .forEach(prop => defineProperty(prop, prop));

    this.killed = false;
    this.waiting = null;
    this.paused = 0;
    this.context = this.repl.context;
    this.history = { debug: [], control: [] };
    this.breakpoints = [];
    this._watchers = [];

    // Run script automatically
    // this.pause();

    setImmediate(() => { this.run(); });
  }

  handlePaused(params) {
    console.log('handlePaused', params);
  }

  debugEval(code, context, filename, callback) {
    // if (!this.requireConnection()) return;

    const self = this;
    const client = this.client;

    // Repl asked for scope variables
    if (code === '.scope') {
      client.reqScopes(callback);
      return;
    }

    const frame = client.currentFrame === NO_FRAME ? undefined : client.currentFrame;

    self.pause();

    // Request remote evaluation globally or in current frame
    client.reqFrameEval(code, frame, (err, res) => {
      if (err) {
        callback(err);
        self.resume(true);
        return;
      }

      // Request object by handles (and it's sub-properties)
      client.mirrorObject(res, 3, (mirrorError, mirror) => {
        callback(null, mirror);
        self.resume(true);
      });
    });
  }

  cont() {
    this.client.callMethod('Debugger.resume');
  }

  next() {
    this.client.callMethod('Debugger.stepOver');
  }

  step() {
    this.client.callMethod('Debugger.stepInto');
  }

  out() {
    this.client.callMethod('Debugger.stepOut');
  }

  exec(code) {
    this.debugEval(code, null, null, (err, result) => {
      if (err) {
        this.error(err);
      } else {
        this.print(util.inspect(result, { colors: true }));
      }
    });
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
  print(text, oneline) {
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
    this.repl.displayPrompt(true);
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

  // Spawns child process (and restores breakpoints)
  trySpawn(cb) {
    const breakpoints = this.breakpoints || [];
    let port = exports.port;
    let host = '127.0.0.1';
    let childArgs = this.args;

    this.killChild();
    assert(!this.child);

    let isRemote = false;
    console.log(this.args);
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

    client.once('ready', () => {
      this.stdout.write(' ok\n');

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
    console.error('Usage: node debug script.js');
    console.error('       node debug <host>:<port>');
    console.error('       node debug -p <pid>');
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
