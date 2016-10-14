'use strict';
const spawn = require('child_process').spawn;

const CLI = require.resolve('../../cli.js');

function startCLI(args) {
  const child = spawn(process.execPath, [CLI, ...args]);
  let isFirstStdoutChunk = true;

  const outputBuffer = [];
  function bufferOutput(chunk) {
    if (isFirstStdoutChunk) {
      isFirstStdoutChunk = false;
      outputBuffer.push(chunk.replace(/^debug>\s*/, ''));
    } else {
      outputBuffer.push(chunk);
    }
  }

  function getOutput() {
    return outputBuffer.join('').toString()
      .replace(/^[^\n]*[\b]/mg, '\n');
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', bufferOutput);
  child.stderr.setEncoding('utf8');
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

    waitForPrompt() {
      return new Promise((resolve, reject) => {
        function checkOutput() {
          if (/debug>\s*$/.test(getOutput())) {
            child.stdout.removeListener('data', checkOutput);
            resolve();
          }
        }
        child.on('exit', () => {
          reject(new Error('Child quit while waiting for prompt'));
        });
        child.stdout.on('data', checkOutput);
        checkOutput();
      });
    },

    get output() {
      return getOutput();
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
