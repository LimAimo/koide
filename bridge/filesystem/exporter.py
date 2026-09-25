"""把文件或文件夹打成 zip 以便下载。跳过体积巨大或可再生成的目录。"""
from __future__ import annotations

import os
import tempfile
import zipfile
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".gradle", ".idea"}
MAX_TOTAL = 300 * 1024 * 1024


def make_zip(path: Path):
    """返回 (临时文件, 大小, 下载文件名)。超过体积上限时抛出 ValueError。"""
    path = Path(path)
    tmp = tempfile.SpooledTemporaryFile(max_size=32 * 1024 * 1024)
    total = 0
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        if path.is_file():
            z.write(path, path.name)
            total = path.stat().st_size
        else:
            base = path.name or "project"
            for dirpath, dirs, files in os.walk(path):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                for fn in files:
                    fp = Path(dirpath) / fn
                    if fn.startswith(".diffusion-tmp-") or fp.is_symlink():
                        continue
                    try:
                        total += fp.stat().st_size
                    except OSError:
                        continue
                    if total > MAX_TOTAL:
                        raise ValueError("内容超过 300 MB，无法一次性导出，请分批导出子文件夹")
                    z.write(fp, f"{base}/{fp.relative_to(path).as_posix()}")
    size = tmp.tell()
    tmp.seek(0)
    return tmp, size, (path.name or "project") + ".zip"
