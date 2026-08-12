const PIECE_UNIT = 'Pcs';
const LENGTH_UNIT = 'm';

const PIECE_KEYWORDS = [
  'cosse',
  'vis',
  'ecrou',
  'rondelle',
  'connecteur',
  'disjoncteur',
  'prise',
  'interrupteur',
  'collier',
  'embout',
  'fusible',
  'relais',
];

const LENGTH_KEYWORDS = [
  'fil',
  'cable',
  'fibre',
  'gaine',
  'tube',
  'tuyau',
  'conducteur',
  'membrane',
  'tpc',
];

function normalizeAutomaticUnitDesignation(designation) {
  return String(designation || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAutomaticUnitKeyword(normalizedDesignation, keywords) {
  return keywords.some((keyword) => {
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escapedKeyword}s?(?=\\s|$)`).test(normalizedDesignation);
  });
}

export function getAutomaticUnit(designation) {
  const normalizedDesignation = normalizeAutomaticUnitDesignation(designation);
  if (!normalizedDesignation) {
    return PIECE_UNIT;
  }

  if (containsAutomaticUnitKeyword(normalizedDesignation, PIECE_KEYWORDS)) {
    return PIECE_UNIT;
  }

  if (containsAutomaticUnitKeyword(normalizedDesignation, LENGTH_KEYWORDS)) {
    return LENGTH_UNIT;
  }

  return PIECE_UNIT;
}
