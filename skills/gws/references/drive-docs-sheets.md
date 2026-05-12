# Drive, Docs & Sheets Commands

## Drive

```bash
# Search for files by name
gws drive files list --params '{"q": "name contains '\''budget'\''", "pageSize": 10}'

# Search for spreadsheets specifically
gws drive files list --params '{"q": "mimeType='\''application/vnd.google-apps.spreadsheet'\'' and name contains '\''Q1'\''", "pageSize": 10}'

# List recent files
gws drive files list --params '{"pageSize": 10, "orderBy": "modifiedTime desc"}'

# Upload a file
gws drive +upload ./report.pdf --name "Q1 Report"

# Download a file
gws drive files get --params '{"fileId": "FILE_ID", "alt": "media"}' -o ./file.pdf

# Export Google Doc as PDF
gws drive files export --params '{"fileId": "DOC_ID", "mimeType": "application/pdf"}' -o ./doc.pdf

# Create a folder
gws drive files create --json '{"name": "Project Files", "mimeType": "application/vnd.google-apps.folder"}'
```

## Sheets

```bash
# Read a range
gws sheets +read --spreadsheet "SPREADSHEET_ID" --range "Sheet1!A1:D10"

# Append rows
gws sheets +append \
  --spreadsheet "SPREADSHEET_ID" \
  --json-values '[["Name", "Score"], ["Alice", 95]]'

# Create a new spreadsheet
gws sheets spreadsheets create --json '{"properties": {"title": "Budget Tracker"}}'

# Get spreadsheet metadata
gws sheets spreadsheets get --params '{"spreadsheetId": "ID"}'
```

## Docs

```bash
# Create a document
gws docs documents create --json '{"title": "Meeting Notes"}'

# Read a document
gws docs documents get --params '{"documentId": "DOC_ID"}'

# Append text
gws docs +write --document "DOC_ID" --text "New section content here"
```
