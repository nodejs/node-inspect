/* eslint no-restricted-syntax: 0, no-debugger: 0 */
'use strict';
console.log('initial thing');
debugger;
const strings = require('./strings.js');
const x = process.argv[2] || strings.world;
setInterval(() => {
  // debugger;
  console.log(x);
}, 1000);
console.log(strings.hello);
