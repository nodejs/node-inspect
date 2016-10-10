'use strict';
require('../common');
process.env.NODE_FORCE_READLINE = 1;

var repl = require('./helper-debugger-repl.js');

repl.startDebugger('breakpoints.js');

var addTest = repl.addTest;

// next
addTest('n', [
  /^n$/,
  /break in .*:11/,
  /9/, /10/, /11/, /12/, /13/
]);

// should repeat next
addTest('', [
  /^$/,
  /break in .*:5/,
  /3/, /4/, /5/, /6/, /7/,
]);

// continue
addTest('c', [
  /^c$/,
  /break in .*:12/,
  /10/, /11/, /12/, /13/, /14/
]);

// should repeat continue
addTest('', [
  /^$/,
  /break in .*:5/,
  /3/, /4/, /5/, /6/, /7/,
]);

// should repeat continue
addTest('', [
  /^$/,
  /break in .*:23/,
  /21/, /22/, /23/, /24/, /25/,
]);
