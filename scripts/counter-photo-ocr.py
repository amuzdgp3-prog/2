#!/usr/bin/env python3
"""Read meter photos on this PC and send meter readings to the site's worker API."""
import argparse
from collections import Counter
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from counter_photo_chatgpt import read_pair


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
    print(f"Сверка через ChatGPT: {os.environ.get('SITE2_CHATGPT_MODEL', 'gpt-6-luna')}, заданий {len(jobs)}", flush=True)
    results = Counter()
    started = time.monotonic()
    for index, job in enumerate(jobs):
        if time.monotonic() - started >= 900:
            results["DEFERRED"] = len(jobs) - index
            break
        key = job["photoObjectKey"]
        if not re.fullmatch(r"services/[A-Za-z0-9_-]+[.][A-Za-z0-9]+", key):
            raise RuntimeError("Продовый API вернул неверный ключ фото счётчиков")
        photo = photos / key
        if not photo.is_file():
            results["WAITING_FOR_PHOTO"] += 1
            continue
        readings = read_pair(photo)
        result = api_request(f"/{int(job['id'])}/result", {"values": readings})
        results[result["status"]] += 1
    print("Сверка фото:", json.dumps(results, ensure_ascii=False, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--photo", type=Path, nargs="+", help="проверить локальные фото без обращения к API")
    args = parser.parse_args()
    if args.photo:
        for photo in args.photo:
            print(json.dumps(read_pair(photo)), flush=True)
    else:
        state_dir = Path.home() / ".local/state/site2"
        state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (state_dir / "counter-photo-ocr.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print("Сверка уже выполняется")
                return
            run_pending()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        sys.exit(str(error))
