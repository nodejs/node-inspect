'use strict';
var assert = require('assertive');

var nodeInspect = require('../');

describe('node-inspect', function () {
  it('is empty', function () {
    assert.deepEqual({}, nodeInspect);
  });
});
