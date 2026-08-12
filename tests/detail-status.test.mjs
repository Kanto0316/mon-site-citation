import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEcart, isDetailCompleted, normalizeQuantity, quantitiesAreEqual } from '../js/detail-status.js';

test('normalizes decimal comma quantities', () => {
  assert.equal(normalizeQuantity('0,5'), 0.5);
  assert.equal(normalizeQuantity(null), 0);
  assert.equal(normalizeQuantity(undefined), 0);
  assert.equal(normalizeQuantity(''), 0);
});

test('marks integer rebus total as completed', () => {
  assert.equal(isDetailCompleted({ qteSortie: 1, qtePosee: 0, qteRebus: 1, qteRetour: 0 }), true);
});

test('marks 0,5 rebus plus 0,5 retour as completed', () => {
  assert.equal(isDetailCompleted({ qteSortie: '1', qtePosee: '0', qteRebus: '0,5', qteRetour: '0,5' }), true);
});

test('marks 0,3 rebus plus 0,7 retour as completed', () => {
  assert.equal(isDetailCompleted({ qteSortie: '1', qtePosee: '0', qteRebus: '0,3', qteRetour: '0,7' }), true);
});

test('handles floating point precision for 0.1 + 0.2', () => {
  const detail = { qteSortie: '0,3', qtePosee: 0, qteRebus: '0,1', qteRetour: '0,2' };
  assert.equal(isDetailCompleted(detail), true);
  assert.equal(quantitiesAreEqual(computeEcart(detail), 0), true);
});

test('does not mark totals lower than sortie as completed', () => {
  assert.equal(isDetailCompleted({ qteSortie: 1, qtePosee: 0, qteRebus: 0.4, qteRetour: 0.5 }), false);
});

test('does not mark totals greater than sortie as completed', () => {
  assert.equal(isDetailCompleted({ qteSortie: 1, qtePosee: 0, qteRebus: 0.6, qteRetour: 0.5 }), false);
});
