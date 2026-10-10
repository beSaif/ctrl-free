// File types the table import reads (backend app/tables.py): catalogue, install rules and price lists.
export const TABLE_ACCEPT = [
  '.csv', '.tsv', '.txt', '.xlsx', '.xlsm', '.xls', '.ods', '.json', '.pdf',
  'text/csv', 'text/tab-separated-values', 'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel', 'application/vnd.oasis.opendocument.spreadsheet', 'application/json', 'application/pdf',
].join(',')
