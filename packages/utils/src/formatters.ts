/**
 * Formatting utilities for display values across PWA and Web Portal.
 *
 * Covers currency, dates, percentages, and distance formatting
 * with Indonesian locale defaults.
 */

/**
 * Format a number as Indonesian Rupiah currency string.
 */
export function formatCurrency(
  amount: number,
  locale = 'id-ID'
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Format a date to Indonesian locale string.
 */
export function formatDate(
  date: Date | string,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('id-ID', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...options,
  });
}

/**
 * Format a percentage value with one decimal precision.
 */
export function formatPercentage(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * Format distance in meters to a human-readable string.
 * Shows meters if < 1000m, otherwise shows km.
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}
