/**
 * UOM (Unit of Measure) conversion utilities.
 *
 * Materials define multi-tier packaging (e.g., Karton → Box → Strip → Pcs) via
 * `master_material.uom_conversion_rules` — a map of UOM code → quantity of base
 * units contained in one unit of that UOM. The base UOM always resolves to a
 * factor of 1.
 *
 * Example rules for a material whose base UOM is PCS:
 *   { "PCS": 1, "STRIP": 10, "BOX": 100, "KARTON": 1200 }
 * Here one BOX = 100 PCS, one KARTON = 1200 PCS.
 */

/** UOM conversion rules — maps a UOM code to how many base units it contains. */
export interface UOMConversionRules {
  [uomCode: string]: number;
}

/** Thrown when a requested UOM is missing or invalid in a material's rules. */
export class UOMConversionError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'UOMConversionError';
  }
}

/**
 * Returns the number of base units contained in one unit of the given UOM.
 * @throws {UOMConversionError} If the UOM is not defined or the factor is invalid.
 */
export function getUomFactor(rules: UOMConversionRules, uom: string): number {
  const factor = rules[uom];
  if (factor == null) {
    throw new UOMConversionError('UOM_NOT_DEFINED', `UOM "${uom}" is not defined for this material`);
  }
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new UOMConversionError('UOM_INVALID_FACTOR', `UOM "${uom}" has an invalid conversion factor`);
  }
  return factor;
}

/**
 * Converts a quantity in the selected UOM to the equivalent number of base units.
 * @throws {UOMConversionError} If the UOM is invalid.
 */
export function convertToBaseUnits(rules: UOMConversionRules, qty: number, uom: string): number {
  return qty * getUomFactor(rules, uom);
}

/**
 * Converts a base-unit quantity into the target UOM. Result may be fractional
 * when the base quantity does not divide evenly into the target UOM.
 * @throws {UOMConversionError} If the target UOM is invalid.
 */
export function convertFromBaseUnits(rules: UOMConversionRules, baseQty: number, targetUom: string): number {
  return baseQty / getUomFactor(rules, targetUom);
}
