"""Read the two meter windows through Codex authenticated with ChatGPT."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import math

import cv2
import numpy as np
from PIL import Image, ImageOps

PROMPT = """Прочитай два механических счётчика на фото аппарата.
Даны виды ОДНОГО снимка: исходный, повёрнутый на 180 градусов и четыре
увеличенных фрагмента, некоторые также повёрнуты. На всех видах одни и те же ДВА
счётчика, каждый считай только один раз. Фрагменты помогают рассмотреть цифры.
Каждый счётчик — отдельное окно с рядом цифровых барабанов. Сначала определи
ориентацию КАЖДОГО окна отдельно: один счётчик может быть установлен вверх ногами.
У перевёрнутого окна мысленно поверни весь ряд на 180 градусов перед чтением.
Читай центральный ряд цифр, учитывай блики и положение барабана между цифрами.
Не читай цены, телефонные номера, надписи и отражения как показания.
Верни reading_a и reading_b как строки цифр с ведущими нулями, в любом порядке.
Обычно в одном окне шесть барабанов: внимательно посчитай их и прочитай каждый,
не сокращай число, не теряй повторяющиеся единицы или ведущие нули.
Значения не нужно относить к играм или призам. Не придумывай невидимые цифры.
Если одного счётчика нет или его нельзя уверенно прочитать, верни null для него.
Пользуйся только приложенным изображением. Верни только JSON по заданной схеме."""

SCHEMA = {
    "type": "object",
    "properties": {
        "reading_a": {"type": ["string", "null"]},
        "reading_b": {"type": ["string", "null"]},
    },
    "required": ["reading_a", "reading_b"],
    "additionalProperties": False,
}


def meter_fragments(image):
    """Locate dark rectangular windows to enlarge them for the vision model."""
    cv2.setNumThreads(2)
    width, height = image.size
    gray = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
    mask = cv2.threshold(gray, 65, 255, cv2.THRESH_BINARY_INV)[1]
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, width // 140), max(3, height // 180)))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = w * h
        if 1.1 < w / h < 4.8 and 0.001 < area / (width * height) < 0.15 and cv2.contourArea(contour) / area > 0.65:
            boxes.append((x, y, w, h))
    pairs = []
    for index, first in enumerate(boxes):
        x, y, w, h = first
        for second in boxes[index + 1:]:
            x2, y2, w2, h2 = second
            size_difference = abs(math.log((w * h) / (w2 * h2)))
            distance = math.hypot((x + w / 2 - x2 - w2 / 2) / width, (y + h / 2 - y2 - h2 / 2) / height)
            if size_difference < 0.8 and distance < 0.5:
                pairs.append((size_difference + distance, first, second))
    if pairs:
        _, first, second = min(pairs)
        fragments = []
        for x, y, w, h in (first, second):
            crop = image.crop((max(0, x - w // 10), max(0, y - h // 10),
                               min(width, x + w + w // 10), min(height, y + h + h // 10)))
            fragments += [crop, crop.transpose(Image.Transpose.ROTATE_180)]
        return fragments
    return [
        image.crop((int(left * width), int(top * height),
                    min(width, int((left + 0.6) * width)), min(height, int((top + 0.6) * height))))
        for left, top in ((0, 0), (0.4, 0), (0, 0.4), (0.4, 0.4))
    ]


def parse_readings(result):
    if not isinstance(result, dict) or set(result) != {"reading_a", "reading_b"}:
        raise RuntimeError("ChatGPT вернул неверную структуру показаний")
    values = []
    for key in ("reading_a", "reading_b"):
        value = result[key]
        if value is None:
            continue
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,12}", value):
            raise RuntimeError("ChatGPT вернул неверный формат показания")
        values.append(int(value))
    if len(values) != 2 or values[0] == values[1]:
        return None
    return tuple(sorted(values))


def read_pair(photo):
    executable = os.environ.get("SITE2_CODEX_BIN") or shutil.which("codex")
    if not executable:
        raise RuntimeError("Codex CLI не найден для подключения к ChatGPT")
    photo = Path(photo).resolve(strict=True)
    model = os.environ.get("SITE2_CHATGPT_MODEL", "gpt-6-luna")
    timeout = int(os.environ.get("SITE2_CHATGPT_TIMEOUT_SECONDS", "180"))
    if timeout <= 0:
        raise RuntimeError("Таймаут ChatGPT должен быть положительным")
    # The model receives only the attached photo. Keep worker/API credentials
    # outside the inference process, and use a fresh directory for each reading.
    allowed = {
        "HOME", "PATH", "LANG", "LC_ALL", "XDG_RUNTIME_DIR",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "http_proxy", "https_proxy", "all_proxy", "no_proxy",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "CODEX_CA_CERTIFICATE",
    }
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    with tempfile.TemporaryDirectory(prefix="site2-chatgpt-") as directory:
        workspace = Path(directory)
        schema = workspace / "schema.json"
        output = workspace / "reading.json"
        upright = workspace / "photo.jpg"
        rotated = workspace / "photo-180.jpg"
        with Image.open(photo) as source:
            normalized = ImageOps.exif_transpose(source).convert("RGB")
            normalized.save(upright, quality=95)
            normalized.transpose(Image.Transpose.ROTATE_180).save(rotated, quality=95)
            fragments = []
            for index, crop in enumerate(meter_fragments(normalized)):
                fragment = workspace / f"detail-{index}.jpg"
                crop.save(fragment, quality=95)
                fragments.append(fragment)
        schema.write_text(json.dumps(SCHEMA), encoding="utf-8")
        args = [
            executable, "exec", "--ignore-user-config", "--ignore-rules",
            "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
            "--model", model, "--cd", str(workspace),
            "--output-schema", str(schema), "--output-last-message", str(output),
            "--image", str(upright), "--image", str(rotated), "--color", "never",
            "-c", 'web_search="disabled"',
            "-c", 'model_reasoning_effort="high"',
        ]
        for feature in ("shell_tool", "unified_exec", "apps", "multi_agent",
                        "image_generation", "view_image", "memories"):
            args += ["--disable", feature]
        for fragment in fragments:
            args += ["--image", str(fragment)]
        args += ["--", PROMPT]
        try:
            response = subprocess.run(
                args, env=environment, cwd=workspace, capture_output=True,
                text=True, timeout=timeout, check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("ChatGPT не ответил вовремя, задание осталось в очереди") from error
        if response.returncode:
            raise RuntimeError(
                f"Ошибка подключения к ChatGPT (Codex {response.returncode}), задание осталось в очереди"
            )
        if not output.is_file():
            raise RuntimeError("ChatGPT не вернул результат, задание осталось в очереди")
        try:
            result = json.loads(output.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError) as error:
            raise RuntimeError("ChatGPT вернул неверный JSON, задание осталось в очереди") from error
        return parse_readings(result)
