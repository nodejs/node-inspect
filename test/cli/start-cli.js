'use strict';
const spawn = require('child_process').spawn;

const CLI = require.resolve('../../cli.js');

function startCLI(args) {
  const child = spawn(process.execPath, [CLI, ...args]);

  const outputBuffer = [];
  function bufferOutput(chunk) {
    outputBuffer.push(chunk);
  }

  child.stdout.on('data', bufferOutput);
  child.stderr.on('data', bufferOutput);

  if (process.env.VERBOSE === '1') {
    child.stdout.pipe(process.stderr);
    child.stderr.pipe(process.stderr);
  }

  return {
    flushOutput() {
      const output = this.output;
      outputBuffer.length = 0;
      return output;
    },

    get output() {
      return Buffer.concat(outputBuffer).toString()
        .replace(/^[^\n]*[\b]/mg, '\n');
    },

    quit() {
      return new Promise((resolve) => {
        child.stdin.end();
        child.on('exit', resolve);
      });
    },
  };
}
module.exports = startCLI;
