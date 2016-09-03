/* eslint no-restricted-syntax: 0, no-debugger: 0 */
'use strict';
const x = process.argv[2] || 'world';
setTimeout(() => {
  debugger;
  console.log(x);
}, 1000);
console.log('hello');
