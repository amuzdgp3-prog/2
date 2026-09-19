#!/usr/bin/env python3
"""
Генератор PDF с наклейками на аппараты.
Размер наклейки: 7 см × 3 см.
Расположение: 3 столбца × 9 строк на листе А4.
"""
import re
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont('DS', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))

raw_addresses = """Мурино, Охтинская аллея ул., 14
Мурино, Шувалова ул, 22
Мурино, Графская ул, 7
Мурино, Шувалова ул, 3
Бугры, Чайная ул, 2
Бугры, Воронцовский б-р, 11
Тимуровская ул, 8 к1,
Просвещения пр-кт, 75
Просвещения пр-кт, 74 к2
Художников пр, 45 л.А
Сиреневый б-р, 6
Художников пр, 32 л.А
Художников пр-кт, 24
Художников пр-кт, 22
Есенина ул., 5
Луначарского пр, 52
Энгельса пр, 128
Выборгское ш, 7
Композиторов ул., 5 к.3
Суздальское ш, 20 к2
Порошкино, Ленинградское 25
Юкки, Ленинградское ш., 22
Парголово, Межозёрная ул, 14
Песочный, Ленинградская ул, 62
Левашово, Садовая ул, 12
Парголово, Тихоокеанская ул, 1 к2
Парголово, Архитектора Белова, 6 к.5,
Парголово, Заречная ул, 33
Парголово, Выборгское ш, 393
Богатырский 41
Оптиков, д. 46. к.1
Сестрорецк, Приморское ш 293
Сестрорецк, Воскова, 10
Любань, Московское ш, 7 ч.з.
Любань, Мельникова пр-кт, 14 ч.з.
Рябово, Рычина ул., 14
Нурма д, д. 12
Тосно г, Московское ш, д. 33А
Ульяновка, Победы ул, д. 41
Ульяновка, Володарского пр-кт, 69
Колпино, ул Ижорского Батальона, д. 13
Колпино, Балканская дор, 10
Колпино, пр-кт Ленина, д. 42, к. 1,
Бурцева, 23
Ленинский пр-кт, 156
Московский пр-кт, 191а
Нарвский пр-кт, 22
Новоизмайловский пр-кт, 28, к 2
Английский пр-кт, 16
Новоизмайловский пр-кт, 40, к 2
Пулковское ш, 107
Мурино Шувалова 28
Мурино Петровский Б-р 14
Бухарестская 33
Новоселье Невская 11
Наб Реки Каменки 17
Богатырский 63
Стародеревенская, 19
Стародеревенская, 25
Красное Село,5
Отрадное, 1-я линия, 71/1
Виллози, 11
Промышленная, 19
Новый Свет, 46
Пудомяги, 15
Мистолово, Горная, 7
Щеглово, Магистральная, 6
Мендсары, Дачная, 15
Коммунар
Ветеранов 110
Варшавская 122
Агалатово
Оптиков 37
Яхтенная 38
Бугры Английская 6
Дибуновская 37
Культуры пр-т 22
Маршала жукова 35к3
Счастливая 14
Бухарестская 158
Седова 65
Сойкино
Малые Колпаны
Войсковицы
Всеволожск
Лиственная 20
Савушкина 139
Н Токсово
Шаврова 5
Федоровское
Малый проспект ВО, 52
Ветеранов, 151
Партизана Германа, 22
Охтинская тер, зд 1
Сярьги
Парголово, Михайловская дор
Сертолово
Парголово, Федора Абрамова, 19
Красное Село, Лермонтова, 15
Иннолово
Колпино Ижорского батальона 13 пр
Колпино Труд 18 пр
Колпино Труд 35 пр
Колпино ИжБат 7 пр
Колпино Пролетарская 60
Мурино Шувалова 27/7
Просвещения 48
Ломоносов пр
Караваевская 24"""


def clean_address(addr):
    addr = addr.strip()
    if not addr:
        return None
    addr = addr.replace(',', ' ')
    addr = addr.replace('.', ' ')
    addr = re.sub(r'\bпр-кт\b', '', addr)
    addr = re.sub(r'\bпр-т\b', '', addr)
    addr = re.sub(r'\bпр\b', '', addr)
    addr = re.sub(r'\bб-р\b', '', addr, flags=re.IGNORECASE)
    addr = re.sub(r'\bул\b', '', addr)
    addr = re.sub(r'\bд\b', '', addr)
    addr = re.sub(r'\bш\b', '', addr)
    addr = re.sub(r'\bл\b', '', addr)
    addr = re.sub(r'\bк\s*(\d)', r'\1', addr)
    addr = re.sub(r'\s+', ' ', addr).strip()
    return addr if addr else None


def wrap_text(text, max_chars=18):
    words = text.split()
    # Одно слово — одна строка
    if len(words) == 1:
        return [text]
    # 2 слова — всегда на2 строки
    if len(words) == 2:
        return words
    # Больше2 слов — ищем разрыв ближе к середине
    mid = len(text) // 2
    best = -1
    for i, ch in enumerate(text):
        if ch == ' ':
            if best == -1 or abs(i - mid) < abs(best - mid):
                best = i
    if best > 0:
        return [text[:best].strip(), text[best+1:].strip()]
    return [text]


# Параметры
SW, SH = 7*cm, 3*cm
GX, GY = 2*mm, 2*mm
PAGE_W, PAGE_H = A4
COLS, ROWS = 3, 9
total_w = COLS*SW + (COLS-1)*GX
total_h = ROWS*SH + (ROWS-1)*GY
ox = (PAGE_W - total_w)/2
oy = (PAGE_H - total_h)/2
per_page = COLS * ROWS

addresses = [clean_address(l) for l in raw_addresses.strip().split('\n')]
addresses = [a for a in addresses if a]

print(f"Адресов: {len(addresses)}, на листе: {per_page}")
print(f"Листов: {(len(addresses)+per_page-1)//per_page}")

c = canvas.Canvas('/home/s/stickers_A4.pdf', pagesize=A4)

for idx, addr in enumerate(addresses):
    pi = idx % per_page
    if idx > 0 and pi == 0:
        c.showPage()
    col, row = pi % COLS, pi // COLS
    x = ox + col*(SW+GX)
    y = PAGE_H - oy - row*(SH+GY) - SH

    c.setDash(1, 2)
    c.setStrokeColorRGB(0.5, 0.5, 0.5)
    c.setLineWidth(0.3)
    c.rect(x, y, SW, SH, stroke=1, fill=0)
    c.setDash()
    c.setFillColorRGB(0, 0, 0)

    lines = wrap_text(addr)
    if len(lines) == 1:
        fs = 20
        c.setFont('DS', fs)
        tw = c.stringWidth(lines[0], 'DS', fs)
        while tw > SW-4*mm and fs > 10:
            fs -= 0.5
            tw = c.stringWidth(lines[0], 'DS', fs)
        c.setFont('DS', fs)
        tw = c.stringWidth(lines[0], 'DS', fs)
        c.drawString(x+(SW-tw)/2, y+(SH-fs*0.35)/2, lines[0])
    else:
        fs = 16
        c.setFont('DS', fs)
        mw = max(c.stringWidth(l, 'DS', fs) for l in lines)
        while mw > SW-4*mm and fs > 10:
            fs -= 0.5
            mw = max(c.stringWidth(l, 'DS', fs) for l in lines)
        c.setFont('DS', fs)
        lh = fs*1.3
        sy = y + (SH + len(lines)*lh)/2 - lh*0.8
        for i, line in enumerate(lines):
            tw = c.stringWidth(line, 'DS', fs)
            c.drawString(x+(SW-tw)/2, sy-i*lh, line)

c.save()
print("PDF: /home/s/stickers_A4.pdf")


