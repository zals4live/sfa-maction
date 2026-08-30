import { describe, it, expect } from 'bun:test';

import {
  buildExportFilename,
  getReportTitle,
  buildWorksheetTable,
  worksheetTableToAoa,
  XLSX_CONTENT_TYPE,
} from '../report-exporters.js';

interface SampleRow {
  name: string;
  visits: number;
  rate: number;
}

const rows: SampleRow[] = [
  { name: 'Budi', visits: 18, rate: 90 },
  { name: 'Sari', visits: 12, rate: 60 },
];

describe('report-exporters — buildExportFilename', () => {
  it('appends an ISO date and the requested extension', () => {
    expect(buildExportFilename('call-rate', 'xlsx')).toMatch(
      /^call-rate_\d{4}-\d{2}-\d{2}\.xlsx$/
    );
  });
});

describe('report-exporters — getReportTitle', () => {
  it('maps known report ids to human titles', () => {
    expect(getReportTitle('branch-performance')).toBe('Branch Performance Matrix');
  });

  it('falls back to the raw id when unknown', () => {
    expect(getReportTitle('unknown-report')).toBe('unknown-report');
  });
});

describe('report-exporters — buildWorksheetTable', () => {
  it('projects records through ordered columns into a header + rows table', () => {
    const table = buildWorksheetTable(rows, [
      { header: 'Name', value: (r) => r.name },
      { header: 'Visits', value: (r) => r.visits },
      { header: 'Rate %', value: (r) => r.rate },
    ]);
    expect(table.header).toEqual(['Name', 'Visits', 'Rate %']);
    expect(table.rows).toEqual([
      ['Budi', 18, 90],
      ['Sari', 12, 60],
    ]);
  });

  it('produces an empty rows array for no records', () => {
    const table = buildWorksheetTable<SampleRow>([], [
      { header: 'Name', value: (r) => r.name },
    ]);
    expect(table.header).toEqual(['Name']);
    expect(table.rows).toEqual([]);
  });
});

describe('report-exporters — worksheetTableToAoa', () => {
  it('prepends the header as the first AOA row', () => {
    const aoa = worksheetTableToAoa({ header: ['A', 'B'], rows: [[1, 2]] });
    expect(aoa).toEqual([
      ['A', 'B'],
      [1, 2],
    ]);
  });
});

describe('report-exporters — XLSX_CONTENT_TYPE', () => {
  it('is the OpenXML spreadsheet MIME type', () => {
    expect(XLSX_CONTENT_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  });
});
