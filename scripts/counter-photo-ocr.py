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


def read_pair(engine, photo):
    image = cv2.imread(str(photo))
    if image is None:
        return None
    height, width = image.shape[:2]
    crops = (
        image,
        image[height // 12:height * 11 // 12, width // 12:width * 11 // 12],
        image[:, width // 8:width * 7 // 8],
        image[height // 6:height * 5 // 6, :],
    )
    votes = Counter()
    for crop in crops:
        result = engine(crop, use_cls=False)
        if result.txts is None:
            continue
        # The mechanical counters display six wheels. Ignore shorter fragments, prices
        # and phone numbers. Never fill a missing digit using the technician's entry.
        numbers = [
            int(text) for text, score in zip(result.txts, result.scores)
            if score >= 0.90 and re.fullmatch(r"[0-9]{6}", text)
        ]
        if len(numbers) != 2 or numbers[0] == numbers[1]:
            continue
        pair = tuple(sorted(numbers))
        votes[pair] += 1
    if len(votes) == 1:
        pair, count = votes.most_common(1)[0]
        if count >= 2:
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
