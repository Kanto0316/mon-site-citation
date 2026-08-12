import test from 'node:test';
import assert from 'node:assert/strict';
import { getAutomaticUnit } from '../js/automatic-unit.js';

const cases = [
  ['FIL DE CUIVRE', 'm'],
  ['fil de cuivre', 'm'],
  ['CABLE ELECTRIQUE', 'm'],
  ['Câble réseau', 'm'],
  ['GAINE ELECTRIQUE', 'm'],
  ['TUBE PVC', 'm'],
  ['COSSE A SERTIR 240-M12', 'Pcs'],
  ['CONNECTEUR', 'Pcs'],
  ['VIS', 'Pcs'],
  ['ECROU', 'Pcs'],
  ['', 'Pcs'],
  ['cables ethernet', 'm'],
  ['GAINE POUR CABLE ELECTRIQUE', 'm'],
  ['COSSE POUR CABLE', 'Pcs'],
];

test('returns the automatic detail unit from the material designation', () => {
  for (const [designation, expectedUnit] of cases) {
    assert.equal(getAutomaticUnit(designation), expectedUnit, designation);
  }
});
