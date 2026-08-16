from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json

BASE = Path(__file__).resolve().parent
OUTPUT = BASE / "output"
PAGES = json.loads((OUTPUT / "pages.json").read_text(encoding="utf-8"))

FONT_PATHS = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
]

def font(size, index=0):
    for font_path in FONT_PATHS:
        if Path(font_path).exists():
            return ImageFont.truetype(font_path, size=size, index=index)
    return ImageFont.load_default()

TITLE_FONT = font(22)
META_FONT = font(15)

def crop_text(text, length):
    return text if len(text) <= length else text[:length - 1] + "…"

def build_sheet(deck_id, deck_name, pages, start, batch):
    columns = 4
    rows = 3
    cell_w, cell_h = 480, 320
    thumb_h = 270
    sheet = Image.new("RGB", (columns * cell_w, rows * cell_h), "#edf0f4")
    draw = ImageDraw.Draw(sheet)
    for slot, page in enumerate(batch):
        x = (slot % columns) * cell_w
        y = (slot // columns) * cell_h
        screenshot = BASE / page["screenshot"]
        with Image.open(screenshot) as image:
            thumb = image.convert("RGB")
            thumb.thumbnail((cell_w - 12, thumb_h - 10))
            offset_x = x + (cell_w - thumb.width) // 2
            offset_y = y + 5 + (thumb_h - 10 - thumb.height) // 2
            sheet.paste(thumb, (offset_x, offset_y))
        draw.rectangle((x + 5, y + 5, x + cell_w - 5, y + cell_h - 5), outline="#c8ced8", width=2)
        title = f'{page["order"]:02d} · {page["file"]} · {crop_text(page["title"], 30)}'
        draw.text((x + 12, y + thumb_h + 3), title, fill="#14213d", font=TITLE_FONT)
        tags = " / ".join(page["tags"][:4]) or "基础页面"
        draw.text((x + 12, y + thumb_h + 31), crop_text(tags, 52), fill="#667085", font=META_FONT)
    end = start + len(batch) - 1
    target = OUTPUT / "contact-sheets" / deck_id
    target.mkdir(parents=True, exist_ok=True)
    sheet.save(target / f"{start:03d}-{end:03d}.jpg", quality=88, optimize=True)

for deck_id in sorted({page["deckId"] for page in PAGES}):
    deck_pages = [page for page in PAGES if page["deckId"] == deck_id]
    deck_name = deck_pages[0]["deckName"]
    for index in range(0, len(deck_pages), 12):
        build_sheet(deck_id, deck_name, deck_pages, index + 1, deck_pages[index:index + 12])

print(f"Generated contact sheets for {len(PAGES)} pages")
