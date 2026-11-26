"""Offline build check for the standard Python skill helpers.

Exercises PDF extraction/rendering and image/spreadsheet round trips without
task data, credentials, or model calls. Requirements stay in container/tools.
"""

from io import BytesIO

import pdfplumber
from openpyxl import Workbook, load_workbook
from pdf2image import convert_from_bytes
from PIL import Image
from pypdf import PdfReader
from reportlab.pdfgen import canvas


def main():
    with BytesIO() as pdf:
        document = canvas.Canvas(pdf, pagesize=(144, 144))
        document.drawString(10, 72, "Runtime helper check")
        document.save()
        contents = pdf.getvalue()

    with BytesIO(contents) as source:
        assert "Runtime helper check" in PdfReader(source).pages[0].extract_text()
    with BytesIO(contents) as source, pdfplumber.open(source) as document:
        assert "Runtime helper check" in document.pages[0].extract_text()

    pages = convert_from_bytes(contents, dpi=72, first_page=1, last_page=1)
    try:
        assert len(pages) == 1 and pages[0].size == (144, 144)
        with BytesIO() as png:
            pages[0].save(png, format="PNG")
            png.seek(0)
            with Image.open(png) as image:
                assert image.format == "PNG" and image.size == (144, 144)
    finally:
        for page in pages:
            page.close()

    workbook = Workbook()
    try:
        workbook.active["A1"] = 42
        with BytesIO() as xlsx:
            workbook.save(xlsx)
            xlsx.seek(0)
            restored = load_workbook(xlsx)
            try:
                assert restored.active["A1"].value == 42
            finally:
                restored.close()
    finally:
        workbook.close()
    print("Python helper PDF, image, and spreadsheet checks passed.")


if __name__ == "__main__":
    main()
