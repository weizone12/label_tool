import assert from 'node:assert/strict'
import test from 'node:test'
import { assignReidLidsByGid } from './reidLidAssignment.js'

const boxes = (gids) => gids.map((identityId, index) => ({
  id: `box-${index + 1}`,
  type: 'reid',
  identity_id: identityId,
  track_id: null,
}))

test('assigns LIDs from one for consecutive numeric GIDs', () => {
  const result = assignReidLidsByGid(boxes(['1', '2', '3']), 0, false)
  assert.deepEqual(result.map((item) => item.track_id), [1, 2, 3])
})

test('sorts sparse numeric GIDs before assigning LIDs', () => {
  const result = assignReidLidsByGid(boxes(['20', '1', '10']), 0, false)
  assert.deepEqual(result.map((item) => item.track_id), [3, 1, 2])
})

test('does not assign an LID when GID is empty', () => {
  const result = assignReidLidsByGid(boxes(['1', '', '5']), 0, false)
  assert.deepEqual(result.map((item) => item.track_id), [1, null, 2])
})

test('preserves existing LIDs and uses the next available numbers', () => {
  const annotations = boxes(['20', '1', '10'])
  annotations[0].track_id = 1
  const result = assignReidLidsByGid(annotations, 0, false)
  assert.deepEqual(result.map((item) => item.track_id), [1, 2, 3])
})

test('reorders automatically assigned LIDs when a smaller GID is added later', () => {
  const existing = Array.from({ length: 8 }, (_, index) => ({
    id: `existing-${index + 1}`,
    type: 'reid',
    identity_id: String(index + 1),
    track_id: index + 1,
  }))
  const firstResult = assignReidLidsByGid([
    ...existing,
    { id: 'gid-11', type: 'reid', identity_id: '11', track_id: null },
  ], 0, false)
  assert.equal(firstResult.find((item) => item.id === 'gid-11').track_id, 9)
  const secondResult = assignReidLidsByGid([
    ...firstResult,
    { id: 'gid-9', type: 'reid', identity_id: '9', track_id: null },
  ], 0, false)
  assert.equal(secondResult.find((item) => item.id === 'gid-9').track_id, 9)
  assert.equal(secondResult.find((item) => item.id === 'gid-11').track_id, 10)
})
