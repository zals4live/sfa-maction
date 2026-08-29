/**
 * Report export utilities.
 *
 * Placeholder module for Excel (.xlsx) and PDF generation helpers.
 * Actual implementations will integrate with streaming export
 * endpoints on the backend and download triggers on the frontend.
 */

export interface ExportOptions {
  format: 'xlsx' | 'pdf';
  filename: string;
  title?: string;
}

/**
 * Build a standardized export filename with date suffix.
 */
export function buildExportFilename(
  baseName: string,
  format: ExportOptions['format']
): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${baseName}_${date}.${format}`;
}

/**
 * Map report type identifiers to human-readable titles.
 */
export function getReportTitle(reportType: string): string {
  const titles: Record<string, string> = {
    'dashboard-kpi': 'Dashboard KPI Summary',
    'branch-performance': 'Branch Performance Matrix',
    'call-rate': 'Call Rate Report',
    'orders': 'Order Transaction Register',
    'fraud-incidents': 'Fraud Incident Report',
    'attendance': 'Attendance Report',
  };
  return titles[reportType] ?? reportType;
}
