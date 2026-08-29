import { describe, it, expect } from 'bun:test';

import {
  getUomFactor,
  convertToBaseUnits,
  convertFromBaseUnits,
  UOMConversionError,
} from '../uom-converter.js';

const RULES = { PCS: 1, STRIP: 10, BOX: 100, KARTON: 1200 };

describe('uom-converter', () => {
  describe('getUomFactor', () => {
    it('returns the factor for a defined UOM', () => {
      expect(getUomFactor(RULES, 'BOX')).toBe(100);
      expect(getUomFactor(RULES, 'PCS')).toBe(1);
    });

    it('throws UOM_NOT_DEFINED for a missing UOM', () => {
      try {
        getUomFactor(RULES, 'PALLET');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(UOMConversionError);
        expect((err as UOMConversionError).code).toBe('UOM_NOT_DEFINED');
      }
    });

    it('throws UOM_INVALID_FACTOR for a zero or negative factor', () => {
      try {
        getUomFactor({ BAD: 0 }, 'BAD');
        expect(true).toBe(false);
      } catch (err) {
        expect((err as UOMConversionError).code).toBe('UOM_INVALID_FACTOR');
      }
    });
  });

  describe('convertToBaseUnits', () => {
    it('scales quantity by the UOM factor across tiers', () => {
      expect(convertToBaseUnits(RULES, 2, 'KARTON')).toBe(2400);
      expect(convertToBaseUnits(RULES, 5, 'STRIP')).toBe(50);
      expect(convertToBaseUnits(RULES, 7, 'PCS')).toBe(7);
    });
  });

  describe('convertFromBaseUnits', () => {
    it('divides base units into the target UOM', () => {
      expect(convertFromBaseUnits(RULES, 2400, 'KARTON')).toBe(2);
      expect(convertFromBaseUnits(RULES, 50, 'STRIP')).toBe(5);
    });

    it('yields fractional results when it does not divide evenly', () => {
      expect(convertFromBaseUnits(RULES, 150, 'BOX')).toBe(1.5);
    });
  });
});
