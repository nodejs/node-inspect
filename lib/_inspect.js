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
const Buffer = require('buffer').Buffer;
const { spawn } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const http = require('http');
const Path = require('path');
const Repl = require('repl');
const URL = require('url');
const util = require('util');
const vm = require('vm');

const debuglog = util.debuglog('inspect');

exports.port = 9229;

const SHORTCUTS = {
  cont: 'c',
  next: 'n',
  step: 's',
  out: 'o',
  backtrace: 'bt',
  setBreakpoint: 'sb',
  clearBreakpoint: 'cb',
  run: 'r',
};

const HELP = `
run, restart, r       Run the application or reconnect
kill                  Kill a running application or disconnect

cont, c               Resume execution
next, n               Continue to next line in current file
step, s               Step into, potentially entering a function
out, o                Step out, leaving the current function
backtrace, bt         Print the current backtrace
list                  Print the source around the current line where execution
                      is currently paused

setBreakpoint, sb     Set a breakpoint
clearBreakpoint, cb   Clear a breakpoint
breakpoints           List all known breakpoints
breakOnException      Pause execution whenever an exception is thrown
breakOnUncaught       Pause execution whenever an exception isn't caught
breakOnNone           Don't pause on exceptions (this is the default)

watch(expr)           Start watching the given expression
unwatch(expr)         Stop watching an expression
watchers              Print all watched expressions and their current values

exec(expr)            Evaluate the expression and print the value
repl                  Enter a debug repl that works like exec

scripts               List application scripts that are currently loaded
scripts(true)         List all scripts (including node-internals)
`.trim();

const ProtocolClient = (function setupClient() {
  const kOpCodeText = 0x1;
  const kOpCodeClose = 0x8;

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

  function isEmpty(obj) {
    return Object.keys(obj).length === 0;
  }

  function unpackError({ code, message, data }) {
    const err = new Error(`${message} - ${data}`);
    err.code = code;
    Error.captureStackTrace(err, unpackError);
    return err;
  }

  function encodeFrameHybi17(payload) {
    const dataLength = payload.length;

    let singleByteLength;
    let additionalLength;
    if (dataLength > kMaxTwoBytePayloadLength) {
      singleByteLength = kEightBytePayloadLengthField;
      additionalLength = Buffer.alloc(8);
      let remaining = dataLength;
      for (let i = 0; i < 8; ++i) {
        additionalLength[7 - i] = remaining & 0xFF;
        remaining >>= 8;
      }
    } else if (dataLength > kMaxSingleBytePayloadLength) {
      singleByteLength = kTwoBytePayloadLengthField;
      additionalLength = Buffer.alloc(2);
      additionalLength[0] = (dataLength & 0xFF00) >> 8;
      additionalLength[1] = dataLength & 0xFF;
    } else {
      additionalLength = Buffer.alloc(0);
      singleByteLength = dataLength;
    }

    const header = Buffer.from([
      kFinalBit | kOpCodeText,
      kMaskBit | singleByteLength,
    ]);

    const mask = Buffer.alloc(4);
    const masked = Buffer.alloc(dataLength);
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
    if ((dataAvailable - payloadOffset - payloadLength) < 0) return notComplete;

    const payloadEnd = payloadOffset + payloadLength;
    return {
      payload: data.slice(payloadOffset, payloadEnd),
      rest: data.slice(payloadEnd),
      closed,
    };
  }

  class Client extends EventEmitter {
    constructor(port, host) {
      super();
      this.handleChunk = this._handleChunk.bind(this);

      this._port = port;
      this._host = host;

      this.reset();
    }

    _handleChunk(chunk) {
      this._unprocessed = Buffer.concat([this._unprocessed, chunk]);

      while (this._unprocessed.length > 2) {
        const {
          closed,
          payload: payloadBuffer,
          rest
        } = decodeFrameHybi17(this._unprocessed);
        this._unprocessed = rest;

        if (closed) {
          this.reset();
          return;
        }
        if (payloadBuffer === null) break;

        const payloadStr = payloadBuffer.toString();
        debuglog('< %s', payloadStr);
        const lastChar = payloadStr[payloadStr.length - 1];
        if (payloadStr[0] !== '{' || lastChar !== '}') {
          throw new Error(`Payload does not look like JSON: ${payloadStr}`);
        }
        let payload;
        try {
          payload = JSON.parse(payloadStr);
        } catch (parseError) {
          parseError.string = payloadStr;
          throw parseError;
        }

        const { id, method, params, result, error } = payload;
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
          throw new Error(`Unsupported response: ${payloadStr}`);
        }
      }
    }

    reset() {
      if (this._http) {
        this._http.destroy();
      }
      this._http = null;
      this._lastId = 0;
      this._socket = null;
      this._pending = {};
      this._unprocessed = Buffer.alloc(0);
    }

    callMethod(method, params) {
      return new Promise((resolve, reject) => {
        if (!this._socket) {
          reject(new Error('Use `run` to start the app again.'));
          return;
        }
        const data = { id: ++this._lastId, method, params };
        this._pending[data.id] = (error, result) => {
          if (error) reject(unpackError(error));
          else resolve(isEmpty(result) ? undefined : result);
        };
        const json = JSON.stringify(data);
        debuglog('> %s', json);
        this._socket.write(encodeFrameHybi17(Buffer.from(json)));
      });
    }

    _fetchJSON(urlPath) {
      return new Promise((resolve, reject) => {
        const httpReq = http.get({
          host: this._host,
          port: this._port,
          path: urlPath,
        });

        const chunks = [];

        function onResponse(httpRes) {
          function parseChunks() {
            const resBody = Buffer.concat(chunks).toString();
            if (httpRes.statusCode !== 200) {
              reject(new Error(`Unexpected ${httpRes.statusCode}: ${resBody}`));
              return;
            }
            try {
              resolve(JSON.parse(resBody));
            } catch (parseError) {
              reject(new Error(`Response didn't contain JSON: ${resBody}`));
              return;
            }
          }

          httpRes.on('error', reject);
          httpRes.on('data', (chunk) => chunks.push(chunk));
          httpRes.on('end', parseChunks);
        }

        httpReq.on('error', reject);
        httpReq.on('response', onResponse);
      });
    }

    connect() {
      return this._discoverWebsocketPath()
        .then((urlPath) => this._connectWebsocket(urlPath));
    }

    _discoverWebsocketPath() {
      return this._fetchJSON('/json')
        .then(([{ webSocketDebuggerUrl }]) =>
          URL.parse(webSocketDebuggerUrl).path);
    }

    _connectWebsocket(urlPath) {
      this.reset();

      const key1 = crypto.randomBytes(16).toString('base64');
      debuglog('request websocket', key1);

      const httpReq = this._http = http.request({
        host: this._host,
        port: this._port,
        path: urlPath,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key1,
          'Sec-WebSocket-Version': '13',
        },
      });
      httpReq.on('error', (e) => {
        this.emit('error', e);
      });
      httpReq.on('response', (httpRes) => {
        if (httpRes.statusCode >= 400) {
          process.stderr.write(`Unexpected HTTP code: ${httpRes.statusCode}\n`);
          httpRes.pipe(process.stderr);
        } else {
          httpRes.pipe(process.stderr);
        }
      });

      const handshakeListener = (res, socket) => {
        // TODO: we *could* validate res.headers[sec-websocket-accept]
        debuglog('websocket upgrade');

        this._socket = socket;
        socket.on('data', this.handleChunk);
        socket.on('close', () => {
          this.emit('close');
        });

        Promise.all([
          this.callMethod('Runtime.enable'),
          this.callMethod('Debugger.enable'),
          this.callMethod('Debugger.setPauseOnExceptions', { state: 'none' }),
          this.callMethod('Debugger.setAsyncCallStackDepth', { maxDepth: 0 }),
          this.callMethod('Profiler.enable'),
          this.callMethod('Profiler.setSamplingInterval', { interval: 100 }),
          this.callMethod('Debugger.setBlackboxPatterns', { patterns: [] }),
          this.callMethod('Runtime.runIfWaitingForDebugger'),
        ]).then(() => {
          this.emit('ready');
        }, (error) => {
          this.emit('error', error);
        });
      };

      return new Promise((resolve, reject) => {
        this.once('error', reject);
        this.once('ready', resolve);

        httpReq.on('upgrade', handshakeListener);
        httpReq.end();
      });
    }
  }

  return Client;
}());

function createRepl(inspector) {
  const NATIVES = process.binding('natives');

  function isNativeUrl(url) {
    return url.replace('.js', '') in NATIVES || url === 'bootstrap_node.js';
  }

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

  function markSourceColumn(sourceText, position, useColors) {
    if (!sourceText) return '';

    const head = sourceText.slice(0, position);
    let tail = sourceText.slice(position);

    // Colourize char if stdout supports colours
    if (useColors) {
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

  const FUNCTION_NAME_PATTERN = /^(?:function\*? )?([^(\s]+)\(/;

  class RemoteObject {
    constructor(attributes) {
      Object.assign(this, attributes);
      if (this.type === 'number') {
        this.value =
          this.unserializableValue ? +this.unserializableValue : +this.value;
      }
    }

    [util.inspect.custom](depth, opts) {
      function formatProperty(prop) {
        switch (prop.type) {
          case 'string':
          case 'undefined':
            return util.inspect(prop.value, opts);

          case 'number':
          case 'boolean':
            return opts.stylize(prop.value, prop.type);

          case 'object':
          case 'symbol':
            if (prop.subtype === 'date') {
              return util.inspect(new Date(prop.value), opts);
            }
            if (prop.subtype === 'array') {
              return opts.stylize(prop.value, 'special');
            }
            return opts.stylize(prop.value, prop.subtype || 'special');

          default:
            return prop.value;
        }
      }
      switch (this.type) {
        case 'boolean':
        case 'number':
        case 'string':
        case 'undefined':
          return util.inspect(this.value, opts);

        case 'symbol':
          return opts.stylize(this.description, 'special');

        case 'function': {
          const fnNameMatch = this.description.match(FUNCTION_NAME_PATTERN);
          const fnName = fnNameMatch ? `: ${fnNameMatch[1]}` : '';
          const formatted = `[${this.className}${fnName}]`;
          return opts.stylize(formatted, 'special');
        }

        case 'object':
          switch (this.subtype) {
            case 'date':
              return util.inspect(new Date(this.description), opts);

            case 'null':
              return util.inspect(null, opts);

            case 'regexp':
              return opts.stylize(this.description, 'regexp');

            default:
              break;
          }
          if (this.preview) {
            const props = this.preview.properties
              .map((prop, idx) => {
                const value = formatProperty(prop);
                if (prop.name === `${idx}`) return value;
                return `${prop.name}: ${value}`;
              });
            if (this.preview.overflow) {
              props.push('...');
            }
            const singleLine = props.join(', ');
            const propString =
              singleLine.length > 60 ? props.join(',\n  ') : singleLine;

            return this.subtype === 'array' ?
              `[ ${propString} ]` : `{ ${propString} }`;
          }
          return this.description;

        default:
          return this.description;
      }
    }
  }

  function convertResultToRemoteObject({ result, wasThrown }) {
    if (wasThrown) return convertResultToError(result);
    return new RemoteObject(result);
  }

  function copyOwnProperties(target, source) {
    Object.getOwnPropertyNames(source).forEach((prop) => {
      const descriptor = Object.getOwnPropertyDescriptor(source, prop);
      Object.defineProperty(target, prop, descriptor);
    });
  }

  function aliasProperties(target, mapping) {
    Object.keys(mapping).forEach((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      Object.defineProperty(target, mapping[key], descriptor);
    });
  }

  const { Debugger, Runtime } = inspector;

  let repl; // eslint-disable-line prefer-const

  // Things we want to keep around
  const history = { control: [], debug: [] };
  const watchedExpressions = [];
  const knownBreakpoints = [];
  let pauseOnExceptionState = 'none';
  let lastCommand;

  // Things we need to reset when the app restarts
  let knownScripts;
  let currentBacktrace;
  let selectedFrame;
  let exitDebugRepl;

  function resetOnStart() {
    knownScripts = {};
    currentBacktrace = null;
    selectedFrame = null;

    if (exitDebugRepl) exitDebugRepl();
    exitDebugRepl = null;
  }
  resetOnStart();

  const INSPECT_OPTIONS = { colors: inspector.stdout.isTTY };
  function inspect(value) {
    return util.inspect(value, INSPECT_OPTIONS);
  }

  function print(value, oneline = false) {
    const text = typeof value === 'string' ? value : inspect(value);
    return inspector.print(text, oneline);
  }

  function getCurrentLocation() {
    if (!selectedFrame) {
      throw new Error('Requires execution to be paused');
    }
    return selectedFrame.location;
  }

  function isCurrentScript(script) {
    return selectedFrame && getCurrentLocation().scriptId === script.scriptId;
  }

  function formatScripts(displayNatives = false) {
    function isVisible(script) {
      if (displayNatives) return true;
      return !script.isNative || isCurrentScript(script);
    }

    return Object.keys(knownScripts)
      .map((scriptId) => knownScripts[scriptId])
      .filter(isVisible)
      .map((script) => {
        const isCurrent = isCurrentScript(script);
        const { isNative, url } = script;
        const name = `${getRelativePath(url)}${isNative ? ' <native>' : ''}`;
        return `${isCurrent ? '*' : ' '} ${script.scriptId}: ${name}`;
      })
      .join('\n');
  }
  function listScripts(displayNatives = false) {
    print(formatScripts(displayNatives));
  }
  listScripts[util.inspect.custom] = function listWithoutInternal() {
    return formatScripts();
  };

  class ScopeSnapshot {
    constructor(scope, properties) {
      Object.assign(this, scope);
      this.properties = new Map(properties.map((prop) => {
        // console.error(prop);
        const value = new RemoteObject(prop.value);
        return [prop.name, value];
      }));
    }

    [util.inspect.custom](depth, opts) {
      const type = `${this.type[0].toUpperCase()}${this.type.slice(1)}`;
      const name = this.name ? `<${this.name}>` : '';
      const prefix = `${type}${name} `;
      return util.inspect(this.properties, opts)
        .replace(/^Map /, prefix);
    }
  }

  class SourceSnippet {
    constructor(location, delta, scriptSource) {
      Object.assign(this, location);
      this.scriptSource = scriptSource;
      this.delta = delta;
    }

    [util.inspect.custom](depth, options) {
      const { scriptId, lineNumber, columnNumber, delta, scriptSource } = this;
      const start = Math.max(1, lineNumber - delta + 1);
      const end = lineNumber + delta + 1;

      const lines = scriptSource.split('\n');
      return lines.slice(start - 1, end).map((lineText, offset) => {
        const i = start + offset;
        const isCurrent = i === (lineNumber + 1);

        const markedLine = isCurrent
          ? markSourceColumn(lineText, columnNumber, options.colors)
          : lineText;

        let isBreakpoint = false;
        knownBreakpoints.forEach(({ location }) => {
          if (!location) return;
          if (scriptId === location.scriptId &&
              i === (location.lineNumber + 1)) {
            isBreakpoint = true;
          }
        });

        let prefixChar = ' ';
        if (isCurrent) {
          prefixChar = '>';
        } else if (isBreakpoint) {
          prefixChar = '*';
        }
        return `${leftPad(i, prefixChar, end)} ${markedLine}`;
      }).join('\n');
    }
  }

  function getSourceSnippet(location, delta = 5) {
    const { scriptId } = location;
    return Debugger.getScriptSource({ scriptId })
      .then(({ scriptSource }) =>
        new SourceSnippet(location, delta, scriptSource));
  }

  class CallFrame {
    constructor(callFrame) {
      Object.assign(this, callFrame);
    }

    loadScopes() {
      return Promise.all(
        this.scopeChain
          .filter((scope) => scope.type !== 'global')
          .map((scope) => {
            const { objectId } = scope.object;
            return Runtime.getProperties({
              objectId,
              generatePreview: true,
            }).then(({ result }) => new ScopeSnapshot(scope, result));
          })
      );
    }

    list(delta = 5) {
      return getSourceSnippet(this.location, delta);
    }
  }

  class Backtrace extends Array {
    [util.inspect.custom]() {
      return this.map((callFrame, idx) => {
        const {
          location: { scriptId, lineNumber, columnNumber },
          functionName
        } = callFrame;
        const name = functionName || '(anonymous)';

        const script = knownScripts[scriptId];
        const relativeUrl =
          (script && getRelativePath(script.url)) || '<unknown>';
        const frameLocation =
          `${relativeUrl}:${lineNumber + 1}:${columnNumber}`;

        return `#${idx} ${name} ${frameLocation}`;
      }).join('\n');
    }

    static from(callFrames) {
      return super.from(Array.from(callFrames).map((callFrame) => {
        if (callFrame instanceof CallFrame) {
          return callFrame;
        }
        return new CallFrame(callFrame);
      }));
    }
  }

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

  function evalInCurrentContext(code) {
    // Repl asked for scope variables
    if (code === '.scope') {
      if (!selectedFrame) {
        return Promise.reject(new Error('Requires execution to be paused'));
      }
      return selectedFrame.loadScopes();
    }

    if (selectedFrame) {
      return Debugger.evaluateOnCallFrame({
        callFrameId: selectedFrame.callFrameId,
        expression: code,
        objectGroup: 'node-inspect',
        generatePreview: true,
      }).then(convertResultToRemoteObject);
    }
    return Runtime.evaluate({
      expression: code,
      objectGroup: 'node-inspect',
      generatePreview: true,
    }).then(convertResultToRemoteObject);
  }

  function controlEval(input, context, filename, callback) {
    debuglog('eval:', input);
    function returnToCallback(error, result) {
      debuglog('end-eval:', input, error);
      callback(error, result);
    }

    try {
      const code = prepareControlCode(input);
      const result = vm.runInContext(code, context, filename);

      if (result && typeof result.then === 'function') {
        toCallback(result, returnToCallback);
        return;
      }
      returnToCallback(null, result);
    } catch (e) {
      returnToCallback(e);
    }
  }

  function debugEval(input, context, filename, callback) {
    debuglog('eval:', input);
    function returnToCallback(error, result) {
      debuglog('end-eval:', input, error);
      callback(error, result);
    }

    try {
      const result = evalInCurrentContext(input);

      if (result && typeof result.then === 'function') {
        toCallback(result, returnToCallback);
        return;
      }
      returnToCallback(null, result);
    } catch (e) {
      returnToCallback(e);
    }
  }

  function formatWatchers(verbose = false) {
    if (!watchedExpressions.length) {
      return Promise.resolve('');
    }

    const inspectValue = (expr) =>
      evalInCurrentContext(expr)
        // .then(formatValue)
        .catch((error) => `<${error.message}>`);
    const lastIndex = watchedExpressions.length - 1;

    return Promise.all(watchedExpressions.map(inspectValue))
      .then((values) => {
        const lines = watchedExpressions
          .map((expr, idx) => {
            const prefix = `${leftPad(idx, ' ', lastIndex)}: ${expr} =`;
            const value = inspect(values[idx], { colors: true });
            if (value.indexOf('\n') === -1) {
              return `${prefix} ${value}`;
            }
            return `${prefix}\n    ${value.split('\n').join('\n    ')}`;
          });
        return lines.join('\n');
      })
      .then((valueList) => {
        return verbose ? `Watchers:\n${valueList}\n` : valueList;
      });
  }

  function watchers(verbose = false) {
    return formatWatchers(verbose).then(print);
  }

  // List source code
  function list(delta = 5) {
    return selectedFrame.list(delta)
      .then(null, (error) => {
        print('You can\'t list source code right now');
        throw error;
      });
  }

  function handleBreakpointResolved({ breakpointId, location }) {
    const script = knownScripts[location.scriptId];
    const scriptUrl = script && script.url;
    if (scriptUrl) {
      Object.assign(location, { scriptUrl });
    }
    const isExisting = knownBreakpoints.some((bp) => {
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

  function listBreakpoints() {
    if (!knownBreakpoints.length) {
      print('No breakpoints yet');
      return;
    }

    function formatLocation(location) {
      if (!location) return '<unknown location>';
      const script = knownScripts[location.scriptId];
      const scriptUrl = script ? script.url : location.scriptUrl;
      return `${getRelativePath(scriptUrl)}:${location.lineNumber + 1}`;
    }
    const breaklist = knownBreakpoints
      .map((bp, idx) => `#${idx} ${formatLocation(bp.location)}`)
      .join('\n');
    print(breaklist);
  }

  function setBreakpoint(script, line, condition, silent) {
    function registerBreakpoint({ breakpointId, actualLocation }) {
      handleBreakpointResolved({ breakpointId, location: actualLocation });
      if (actualLocation && actualLocation.scriptId) {
        if (!silent) return getSourceSnippet(actualLocation, 5);
      } else {
        print(`Warning: script '${script}' was not loaded yet.`);
      }
      return undefined;
    }

    // setBreakpoint(): set breakpoint at current location
    if (script === undefined) {
      return Debugger
        .setBreakpoint({ location: getCurrentLocation(), condition })
        .then(registerBreakpoint);
    }

    // setBreakpoint(line): set breakpoint in current script at specific line
    if (line === undefined && typeof script === 'number') {
      const location = {
        scriptId: getCurrentLocation().scriptId,
        lineNumber: script - 1,
      };
      return Debugger.setBreakpoint({ location, condition })
        .then(registerBreakpoint);
    }

    if (typeof script !== 'string') {
      throw new TypeError(`setBreakpoint() expects a string, got ${script}`);
    }

    // setBreakpoint('fn()'): Break when a function is called
    if (script.endsWith('()')) {
      const debugExpr = `debug(${script.slice(0, -2)})`;
      const debugCall = selectedFrame
        ? Debugger.evaluateOnCallFrame({
          callFrameId: selectedFrame.callFrameId,
          expression: debugExpr,
          includeCommandLineAPI: true,
        })
        : Runtime.evaluate({
          expression: debugExpr,
          includeCommandLineAPI: true,
        });
      return debugCall.then(({ result, wasThrown }) => {
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
        const scriptUrl = knownScripts[id].url;
        if (scriptUrl && scriptUrl.indexOf(script) !== -1) {
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

    return Debugger
      .setBreakpointByUrl({ urlRegex, lineNumber: line - 1, condition })
      .then((bp) => {
        // TODO: handle bp.locations in case the regex matches existing files
        if (!bp.location) { // Fake it for now.
          Object.assign(bp, {
            actualLocation: {
              scriptUrl: `.*/${script}$`,
              lineNumber: line - 1,
            },
          });
        }
        return registerBreakpoint(bp);
      });
  }

  function clearBreakpoint(url, line) {
    const breakpoint = knownBreakpoints.find(({ location }) => {
      if (!location) return false;
      const script = knownScripts[location.scriptId];
      if (!script) return false;
      return (
        script.url.indexOf(url) !== -1 && (location.lineNumber + 1) === line
      );
    });
    if (!breakpoint) {
      print(`Could not find breakpoint at ${url}:${line}`);
      return Promise.resolve();
    }
    return Debugger.removeBreakpoint({ breakpointId: breakpoint.breakpointId })
      .then(() => {
        const idx = knownBreakpoints.indexOf(breakpoint);
        knownBreakpoints.splice(idx, 1);
      });
  }

  function restoreBreakpoints() {
    const lastBreakpoints = knownBreakpoints.slice();
    knownBreakpoints.length = 0;
    const newBreakpoints = lastBreakpoints
      .filter(({ location }) => !!location.scriptUrl)
      .map(({ location }) =>
        setBreakpoint(location.scriptUrl, location.lineNumber + 1));
    if (!newBreakpoints.length) return;
    Promise.all(newBreakpoints).then((results) => {
      print(`${results.length} breakpoints restored.`);
    });
  }

  function setPauseOnExceptions(state) {
    return Debugger.setPauseOnExceptions({ state })
      .then(() => {
        pauseOnExceptionState = state;
      });
  }

  Debugger.on('paused', ({ callFrames, reason /* , hitBreakpoints */ }) => {
    // Save execution context's data
    currentBacktrace = Backtrace.from(callFrames);
    selectedFrame = currentBacktrace[0];
    const { scriptId, lineNumber } = selectedFrame.location;

    const breakType = reason === 'other' ? 'break' : reason;
    const script = knownScripts[scriptId];
    const scriptUrl = script ? getRelativePath(script.url) : '[unknown]';
    print(`${breakType} in ${scriptUrl}:${lineNumber + 1}`);

    inspector.suspendReplWhile(() =>
      Promise.all([formatWatchers(true), selectedFrame.list(2)])
        .then(([watcherList, context]) => {
          if (watcherList) {
            return `${watcherList}\n${inspect(context)}`;
          }
          return context;
        }).then(print));
  });

  function handleResumed() {
    currentBacktrace = null;
    selectedFrame = null;
  }

  Debugger.on('resumed', handleResumed);

  Debugger.on('breakpointResolved', handleBreakpointResolved);

  Debugger.on('scriptParsed', (script) => {
    const { scriptId, url } = script;
    if (url) {
      knownScripts[scriptId] = Object.assign({
        isNative: isNativeUrl(url),
      }, script);
    }
  });

  function initializeContext(context) {
    inspector.domainNames.forEach((domain) => {
      Object.defineProperty(context, domain, {
        value: inspector[domain],
        enumerable: true,
        configurable: true,
        writeable: false,
      });
    });

    copyOwnProperties(context, {
      get help() {
        print(HELP);
      },

      get run() {
        return inspector.run();
      },

      get kill() {
        return inspector.killChild();
      },

      get restart() {
        return inspector.run();
      },

      get cont() {
        handleResumed();
        return Debugger.resume();
      },

      get next() {
        handleResumed();
        return Debugger.stepOver();
      },

      get step() {
        handleResumed();
        return Debugger.stepInto();
      },

      get out() {
        handleResumed();
        return Debugger.stepOut();
      },

      get pause() {
        return Debugger.pause();
      },

      get backtrace() {
        return currentBacktrace;
      },

      get breakpoints() {
        return listBreakpoints();
      },

      exec(expr) {
        return evalInCurrentContext(expr);
      },

      get watchers() {
        return watchers();
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

      get repl() {
        // Don't display any default messages
        const listeners = repl.rli.listeners('SIGINT').slice(0);
        repl.rli.removeAllListeners('SIGINT');

        const oldContext = repl.context;

        exitDebugRepl = () => {
          // Restore all listeners
          process.nextTick(() => {
            listeners.forEach((listener) => {
              repl.rli.on('SIGINT', listener);
            });
          });

          // Exit debug repl
          repl.eval = controlEval;

          // Swap history
          history.debug = repl.rli.history;
          repl.rli.history = history.control;

          repl.context = oldContext;
          repl.rli.setPrompt('debug> ');
          repl.displayPrompt();

          repl.rli.removeListener('SIGINT', exitDebugRepl);
          repl.removeListener('exit', exitDebugRepl);

          exitDebugRepl = null;
        };

        // Exit debug repl on SIGINT
        repl.rli.on('SIGINT', exitDebugRepl);

        // Exit debug repl on repl exit
        repl.on('exit', exitDebugRepl);

        // Set new
        repl.eval = debugEval;
        repl.context = {};

        // Swap history
        history.control = repl.rli.history;
        repl.rli.history = history.debug;

        repl.rli.setPrompt('> ');

        print('Press Ctrl + C to leave debug repl');
        repl.displayPrompt();
      },

      get version() {
        return Runtime.evaluate({
          expression: 'process.versions.v8',
          contextId: 1,
          returnByValue: true,
        }).then(({ result }) => {
          print(result.value);
        });
      },

      scripts: listScripts,

      setBreakpoint,
      clearBreakpoint,
      setPauseOnExceptions,
      get breakOnException() {
        return setPauseOnExceptions('all');
      },
      get breakOnUncaught() {
        return setPauseOnExceptions('uncaught');
      },
      get breakOnNone() {
        return setPauseOnExceptions('none');
      },

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

    repl.defineCommand('interrupt', () => {
      // We want this for testing purposes where sending CTRL-C can be tricky.
      repl.rli.emit('SIGINT');
    });

    inspector.client.on('close', () => {
      resetOnStart();
    });

    inspector.client.on('ready', () => {
      restoreBreakpoints();
      Debugger.setPauseOnExceptions({ state: pauseOnExceptionState });
    });

    return repl;
  };
}

function runScript(script, scriptArgs, inspectPort, childPrint) {
  return new Promise((resolve) => {
    const args = [
      '--inspect',
      `--debug-brk=${inspectPort}`,
    ].concat([script], scriptArgs);
    const child = spawn(process.execPath, args);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', childPrint);
    child.stderr.on('data', childPrint);

    let output = '';
    function waitForListenHint(text) {
      output += text;
      if (/chrome-devtools:\/\//.test(output)) {
        child.stderr.removeListener('data', waitForListenHint);
        resolve(child);
      }
    }

    child.stderr.on('data', waitForListenHint);
  });
}

function createAgentProxy(domain, client) {
  const agent = new EventEmitter();
  agent.then = (...args) => {
    // TODO: potentially fetch the protocol and pretty-print it here.
    const descriptor = {
      [util.inspect.custom](depth, { stylize }) {
        return stylize(`[Agent ${domain}]`, 'special');
      },
    };
    return Promise.resolve(descriptor).then(...args);
  };

  return new Proxy(agent, {
    get(target, name) {
      if (name in target) return target[name];
      return function callVirtualMethod(params) {
        return client.callMethod(`${domain}.${name}`, params);
      };
    },
  });
}

class NodeInspector {
  constructor(options, stdin, stdout) {
    this.options = options;
    this.stdin = stdin;
    this.stdout = stdout;

    this.paused = true;
    this.child = null;

    if (options.script) {
      this._runScript = runScript.bind(null,
                                       options.script,
                                       options.scriptArgs,
                                       options.port,
                                       this.childPrint.bind(this));
    } else {
      this._runScript = () => Promise.resolve(null);
    }

    this.client = new ProtocolClient(options.port, options.host);

    this.domainNames = ['Debugger', 'Runtime'];
    this.domainNames.forEach((domain) => {
      this[domain] = createAgentProxy(domain, this.client);
    });
    this.handleDebugEvent = (fullName, params) => {
      const [domain, name] = fullName.split('.');
      if (domain in this) {
        this[domain].emit(name, params);
      }
    };
    this.client.on('debugEvent', this.handleDebugEvent);
    const startRepl = createRepl(this);

    // Handle all possible exits
    process.on('exit', () => this.killChild());
    process.once('SIGTERM', process.exit.bind(process, 0));
    process.once('SIGHUP', process.exit.bind(process, 0));

    this.run()
      .then(() => {
        this.repl = startRepl();
        this.repl.on('exit', () => {
          process.exit(0);
        });
        this.paused = false;
      })
      .then(null, (error) => process.nextTick(() => { throw error; }));
  }

  suspendReplWhile(fn) {
    this.repl.rli.pause();
    this.stdin.pause();
    this.paused = true;
    return new Promise((resolve) => {
      resolve(fn());
    }).then(() => {
      this.paused = false;
      this.repl.rli.resume();
      this.repl.displayPrompt();
      this.stdin.resume();
    }).then(null, (error) => process.nextTick(() => { throw error; }));
  }

  killChild() {
    this.client.reset();
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  run() {
    this.killChild();
    return this._runScript().then((child) => {
      this.child = child;

      let connectionAttempts = 0;
      const attemptConnect = () => {
        ++connectionAttempts;
        debuglog('connection attempt #%d', connectionAttempts);
        this.stdout.write('.');
        return this.client.connect()
          .then(() => {
            debuglog('connection established');
          }, (error) => {
            debuglog('connect failed', error);
            // If it's failed to connect 10 times then print failed message
            if (connectionAttempts >= 10) {
              this.stdout.write(' failed to connect, please retry\n');
              process.exit(1);
            }

            return new Promise((resolve) => setTimeout(resolve, 500))
              .then(attemptConnect);
          });
      };

      const { host, port } = this.options;
      this.print(`connecting to ${host}:${port} ..`, true);
      return attemptConnect();
    });
  }

  clearLine() {
    if (this.stdout.isTTY) {
      this.stdout.cursorTo(0);
      this.stdout.clearLine(1);
    } else {
      this.stdout.write('\b');
    }
  }

  print(text, oneline = false) {
    this.clearLine();
    this.stdout.write(oneline ? text : `${text}\n`);
  }

  childPrint(text) {
    this.print(
      text.toString()
        .split(/\r\n|\r|\n/g)
        .filter((chunk) => !!chunk)
        .map((chunk) => `< ${chunk}`)
        .join('\n')
    );
    if (!this.paused) {
      this.repl.displayPrompt(true);
    }
    if (/Waiting for the debugger to disconnect\.\.\.\n$/.test(text)) {
      this.killChild();
    }
  }
}

function parseArgv([target, ...args]) {
  let host = '127.0.0.1';
  let port = exports.port;
  let isRemote = false;
  let script = target;
  let scriptArgs = args;

  const hostMatch = target.match(/^([^:]+):(\d+)$/);
  const portMatch = target.match(/^--port=(\d+)$/);
  if (hostMatch) {
    // Connecting to remote debugger
    // `node-inspect localhost:9229`
    host = hostMatch[1];
    port = parseInt(hostMatch[2], 10);
    isRemote = true;
    script = null;
  } else if (portMatch) {
    // Start debugger on custom port
    // `node debug --port=8058 app.js`
    port = parseInt(portMatch[1], 10);
    script = args[0];
    scriptArgs = args.slice(1);
  }

  return {
    host, port,
    isRemote, script, scriptArgs,
  };
}

function startInspect(argv = process.argv.slice(2),
                      stdin = process.stdin,
                      stdout = process.stdout) {
  /* eslint-disable no-console */
  if (argv.length < 1) {
    console.error('Usage: node-inspect script.js');
    console.error('       node-inspect <host>:<port>');
    process.exit(1);
  }

  const options = parseArgv(argv);
  const inspector = new NodeInspector(options, stdin, stdout);

  stdin.resume();

  function handleUnexpectedError(e) {
    console.error('There was an internal error in node-inspect. ' +
                  'Please report this bug.');
    console.error(e.message);
    console.error(e.stack);
    if (inspector.child) inspector.child.kill();
    process.exit(1);
  }

  process.on('uncaughtException', handleUnexpectedError);
  /* eslint-enable no-console */
}
exports.start = startInspect;
