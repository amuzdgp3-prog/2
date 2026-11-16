#!/usr/bin/env python3
"""Read meter photos on this PC and send meter readings to the site's worker API."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import cv2
from rapidocr import RapidOCR


def make_engine():
    cv2.setNumThreads(2)
    return RapidOCR(params={
        "Global.use_cls": False,
        "Global.log_level": "warning",
        "EngineConfig.onnxruntime.intra_op_num_threads": 2,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    })


def six_digit_readings(result):
    if result.txts is None:
        return []
    return [
        int(text) for text, score in zip(result.txts, result.scores)
        if score >= 0.90 and re.fullmatch(r"[0-9]{6}", text)
    ]


def read_above_label(engine, image, box):
    x0, y0 = box.min(axis=0)
    x1, y1 = box.max(axis=0)
    width, height = x1 - x0, y1 - y0
    votes = Counter()
    for side, top in ((0.40, 5), (0.65, 6), (0.85, 4.5)):
        crop = image[
            max(0, int(y0 - top * height)):max(0, int(y0 - 0.25 * height)),
            max(0, int(x0 - side * width)):int(x1 + side * width),
        ]
        if crop.size == 0:
            continue
        scale = min(3, 1600 / max(crop.shape[:2]))
        enlarged = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        values = six_digit_readings(engine(enlarged, use_det=True, use_cls=False))
        if len(values) == 1:
            votes[values[0]] += 1
    if len(votes) <= 1 and sum(votes.values()) < 2:
        # Reflections sometimes make the detector split a row of digits. Read the
        # narrow strip above the label directly in that case.
        for side, top, bottom in ((0.33, 4, 1.7), (0.44, 4, 1.9), (0.62, 4.2, 2.2), (0.34, 3.7, 1.5)):
            strip = image[
                max(0, int(y0 - top * height)):max(0, int(y0 - bottom * height)),
                max(0, int(x0 - side * width)):int(x1 + side * width),
            ]
            if strip.size == 0:
                continue
            values = six_digit_readings(engine(strip, use_det=False, use_cls=False))
            if len(values) == 1:
                votes[values[0]] += 1
    if len(votes) == 1:
        value, count = votes.most_common(1)[0]
        if count >= 2:
            return value
    return None


def read_pair(engine, photo):
    image = cv2.imread(str(photo))
    if image is None:
        return None
    height, width = image.shape[:2]
    if min(height, width) < 16:
        return None
    crops = (
        image,
        image[height // 12:height * 11 // 12, width // 12:width * 11 // 12],
        image[:, width // 8:width * 7 // 8],
        image[height // 6:height * 5 // 6, :],
    )
    votes = Counter()
    labels = {}
    for index, crop in enumerate(crops):
        # RapidOCR retains the mode of the preceding call on this engine.
        result = engine(crop, use_det=True, use_cls=False)
        if result.txts is None:
            continue
        if index == 0:
            for text, box in zip(result.txts, result.boxes):
                label = re.sub(r"[^A-Z]", "", text.upper())
                if label in {"COININ", "PRIZEOUT"}:
                    labels[label] = box
        # The mechanical counters display six wheels. Ignore shorter fragments, prices
        # and phone numbers. Never fill a missing digit using the technician's entry.
        numbers = six_digit_readings(result)
        if len(numbers) != 2 or numbers[0] == numbers[1]:
            continue
        pair = tuple(sorted(numbers))
        votes[pair] += 1
    if len(votes) == 1:
        pair, count = votes.most_common(1)[0]
        if count >= 2:
            return pair
    if len(labels) == 2 and len(votes) <= 1:
        # Use the printed text only to locate the windows. Ordering still comes
        # from the detected values, including on panels with reversed counters.
        left, right = (read_above_label(engine, image, box) for box in labels.values())
        if left is not None and right is not None and left != right:
            pair = tuple(sorted((left, right)))
            if not votes or pair in votes:
                return pair
    return None


def api_request(path, payload=None):
    host = "2.apixspb.ru"
    interface = os.environ["SITE2_PROD_INTERFACE"]
    origin_ip = os.environ.get("SITE2_PROD_IP", "185.147.82.69")
    header = os.environ["SITE2_OCR_HEADER_FILE"]
    args = [
        "curl", "--silent", "--show-error", "--noproxy", "*",
        "--interface", interface, "--resolve", f"{host}:443:{origin_ip}",
        "--connect-timeout", "8", "--max-time", "25",
        "--header", f"@{header}", "--write-out", "\n%{http_code}",
        f"https://{host}/api/counter-photo-checks{path}",
    ]
    if payload is not None:
        args += ["--header", "Content-Type: application/json", "--data-binary", "@-"]
    response = subprocess.run(
        args, input=json.dumps(payload) if payload is not None else None,
        text=True, capture_output=True, check=False,
    )
    if response.returncode:
        raise RuntimeError(f"Ошибка подключения к продовому API: curl {response.returncode}")
    body, _, code = response.stdout.rpartition("\n")
    if code == "404" and payload is not None:
        return {"status": "DELETED"}
    if code != "200":
        raise RuntimeError(f"Продовый API вернул HTTP {code}")
    return json.loads(body)


def run_pending():
    jobs = api_request("/pending")
    if not isinstance(jobs, list):
        raise RuntimeError("Продовый API вернул неверный список заданий")
    if not jobs:
        print("Нет новых фото для сверки")
        return
    project = Path(__file__).resolve().parent.parent
    photos = project / "data/photos"
    engine = make_engine()
    results = Counter()
    for job in jobs:
        key = job["photoObjectKey"]
        if not re.fullmatch(r"services/[A-Za-z0-9_-]+[.][A-Za-z0-9]+", key):
            raise RuntimeError("Продовый API вернул неверный ключ фото счётчиков")
        photo = photos / key
        if not photo.is_file():
            results["WAITING_FOR_PHOTO"] += 1
            continue
        readings = read_pair(engine, photo)
        result = api_request(f"/{int(job['id'])}/result", {"values": readings})
        results[result["status"]] += 1
    print("Сверка фото:", json.dumps(results, ensure_ascii=False, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--photo", type=Path, nargs="+", help="проверить локальные фото без обращения к API")
    args = parser.parse_args()
    if args.photo:
        engine = make_engine()
        for photo in args.photo:
            print(json.dumps(read_pair(engine, photo)), flush=True)
    else:
        run_pending()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        sys.exit(str(error))
