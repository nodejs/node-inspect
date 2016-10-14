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
const spawn = require('child_process').spawn;
const Repl = require('repl');

const ProtocolClient = require('./internal/inspect-protocol');

exports.port = 9229;

function throwUnexpectedError(error) {
  process.nextTick(() => { throw error; });
}

function runScript(script, scriptArgs, inspectPort) {
  return new Promise((resolve) => {
    const args = [
      '--inspect',
      `--debug-brk=${inspectPort}`,
    ].concat([script], scriptArgs);
    const child = spawn(process.execPath, args);
    resolve(child);
  });
}

class NodeInspector {
  constructor(options, stdin, stdout) {
    this.options = options;
    this.stdin = stdin;
    this.stdout = stdout;

    this.paused = false;
    this.child = null;

    this._runScript = options.script ?
      runScript.bind(null, options.script, options.scriptArgs, options.port) :
      Promise.resolve.bind(null, null);

    this.client = new ProtocolClient(options.port, options.host);

    // Handle all possible exits
    process.on('exit', () => this.killChild());
    process.once('SIGTERM', process.exit.bind(process, 0));
    process.once('SIGHUP', process.exit.bind(process, 0));

    this.run()
      .then(() => this._setupRepl())
      .then(null, throwUnexpectedError);
  }

  _setupRepl() {
    const replOptions = {
      prompt: 'debug> ',
      input: this.stdin,
      output: this.stdout,
      eval: (code, ctx, file, cb) => this.controlEval(code, ctx, file, cb),
      useGlobal: false,
      ignoreUndefined: true,
    };

    this.repl = Repl.start(replOptions);
    // Kill child process when main process dies
    this.repl.on('exit', () => {
      process.exit(0);
    });
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
      this.child.stdout.on('data', text => this.childPrint(text));
      this.child.stderr.on('data', text => this.childPrint(text));
    });
  }

  clearline() {
    if (this.stdout.isTTY) {
      this.stdout.cursorTo(0);
      this.stdout.clearLine(1);
    } else {
      this.stdout.write('\b');
    }
  }

  print(text, oneline = false) {
    this.clearline();
    this.stdout.write(oneline ? `${text}\n` : text);
  }

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

function start(argv = process.argv.slice(2),
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
exports.start = start;
