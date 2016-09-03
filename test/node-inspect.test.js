'use strict';
const assert = require('assertive');

const nodeInspect = require('../');

describe('node-inspect', () => {
  it('is empty', () => {
    assert.equal(5858, nodeInspect.port);
  });
});
