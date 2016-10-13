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

  return {
    flushOutput() {
      const output = Buffer.concat(outputBuffer).toString();
      outputBuffer.length = 0;
      return output;
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
