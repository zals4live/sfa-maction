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

/**
 * OpenXML spreadsheet MIME type for `.xlsx` downloads.
 */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * A single worksheet cell value. Framework-agnostic — SheetJS accepts these
 * primitives directly as cell values.
 */
export type WorksheetCell = string | number | boolean | null;

/**
 * A worksheet table as an array-of-arrays (AOA): the first row is the header,
 * followed by data rows. This is the shape SheetJS's `aoa_to_sheet` consumes,
 * but the builder itself carries no SheetJS dependency so it stays reusable.
 */
export interface WorksheetTable {
  header: string[];
  rows: WorksheetCell[][];
}

/**
 * Flatten a list of records into a worksheet table by projecting each record
 * through an ordered set of columns. Keeps column order stable and guarantees
 * every data row has the same arity as the header.
 */
export function buildWorksheetTable<T>(
  records: readonly T[],
  columns: ReadonlyArray<{ header: string; value: (record: T) => WorksheetCell }>
): WorksheetTable {
  const header = columns.map((column) => column.header);
  const rows = records.map((record) => columns.map((column) => column.value(record)));
  return { header, rows };
}

/**
 * Merge a worksheet table's header and data rows into a single AOA suitable for
 * SheetJS `aoa_to_sheet`.
 */
export function worksheetTableToAoa(table: WorksheetTable): WorksheetCell[][] {
  return [table.header, ...table.rows];
}
