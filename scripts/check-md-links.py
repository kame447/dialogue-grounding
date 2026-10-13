#!/usr/bin/env python3
"""Git 管理下の Markdown にあるローカル相対リンクを検査する。

リンク先ファイルの存在と、#見出しアンカーの存在（GitHub の slug 規則に近似）を確認する。
外部 URL（http/https/mailto）は検査しない。リポジトリ外を指すリンクも誤りとして報告する。

使い方: python3 scripts/check-md-links.py   （リポジトリのどこからでも可）
終了コード: 0 = リンク切れなし、1 = リンク切れあり
"""
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
FENCE = re.compile(r"^(```|~~~)")


def slug(heading: str) -> str:
    out = []
    for ch in heading.strip().lower():
        cat = unicodedata.category(ch)
        if ch in " -":
            out.append("-" if ch == " " else ch)
        elif ch == "_" or cat[0] in "LN" or cat == "Mn":
            out.append(ch)
    return "".join(out)


def anchors(path: Path) -> set:
    seen, result, fenced = {}, set(), False
    for line in path.read_text(encoding="utf-8").splitlines():
        if FENCE.match(line):
            fenced = not fenced
        if fenced:
            continue
        m = re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
        if m:
            s = slug(m.group(1))
            n = seen.get(s, 0)
            result.add(s if n == 0 else f"{s}-{n}")
            seen[s] = n + 1
    return result


def main() -> int:
    files = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard", "*.md"], cwd=ROOT, text=True).split()
    files = [f for f in files if not Path(f).name.startswith(".")]
    errors, count = [], 0
    for rel in files:
        src = ROOT / rel
        fenced = False
        for no, line in enumerate(src.read_text(encoding="utf-8").splitlines(), 1):
            if FENCE.match(line):
                fenced = not fenced
            if fenced:
                continue
            for target in LINK.findall(line):
                if re.match(r"^[a-z]+:", target):
                    continue
                count += 1
                path_part, _, frag = target.partition("#")
                dest = (src.parent / unquote(path_part)).resolve() if path_part else src
                try:
                    dest.relative_to(ROOT)
                except ValueError:
                    errors.append(f"{rel}:{no}: リポジトリ外を指す: {target}")
                    continue
                if not dest.exists():
                    errors.append(f"{rel}:{no}: ファイルなし: {target}")
                elif frag and dest.suffix == ".md" and unquote(frag).lower() not in anchors(dest):
                    errors.append(f"{rel}:{no}: 見出しなし: {target}")
    for e in errors:
        print(e)
    print(f"検査ファイル {len(files)} 件、ローカルリンク {count} 件、リンク切れ {len(errors)} 件")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
