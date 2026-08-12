export const DETAIL_QUANTITY_EPSILON = 0.000001;

export function normalizeQuantity(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const normalizedValue = typeof value === 'string'
    ? value.trim().replace(',', '.')
    : value;
  const numericValue = Number(normalizedValue);

  return Number.isFinite(numericValue) ? numericValue : 0;
}

export function quantitiesAreEqual(leftValue, rightValue, epsilon = DETAIL_QUANTITY_EPSILON) {
  return Math.abs(normalizeQuantity(leftValue) - normalizeQuantity(rightValue)) < epsilon;
}

export function computeEcart(detail) {
  const qteSortie = normalizeQuantity(detail?.qteSortie);
  const qtePosee = normalizeQuantity(detail?.qtePosee);
  const qteRetour = normalizeQuantity(detail?.qteRetour);
  const qteRebus = normalizeQuantity(detail?.qteRebus);

  if (quantitiesAreEqual(qtePosee, 0) && quantitiesAreEqual(qteRetour, 0) && quantitiesAreEqual(qteRebus, 0)) {
    return '';
  }

  return qteSortie - (qtePosee + qteRetour + qteRebus);
}

export function isDetailCompleted(detail) {
  const qteSortie = normalizeQuantity(detail?.qteSortie);
  const qtePosee = normalizeQuantity(detail?.qtePosee);
  const qteRetour = normalizeQuantity(detail?.qteRetour);
  const qteRebus = normalizeQuantity(detail?.qteRebus);
  const justifiedQuantity = qtePosee + qteRebus + qteRetour;
  const ecart = computeEcart(detail);

  return !quantitiesAreEqual(qteSortie, 0)
    && quantitiesAreEqual(ecart, 0)
    && quantitiesAreEqual(justifiedQuantity, qteSortie);
}
