# /// script
# requires-python = ">=3.10"
# dependencies = ["markdown-it-py==3.0.0"]
# ///

import argparse
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit

from markdown_it import MarkdownIt


def check_document(root: Path, document: Path, parser: MarkdownIt) -> tuple[int, list[str]]:
    name = document.relative_to(root)
    tokens = parser.parse(document.read_text(encoding="utf-8-sig"))
    checked = 0
    errors = []
    for block in tokens:
        for token in block.children or []:
            if token.type == "link_open":
                destination = token.attrGet("href")
            elif token.type == "image":
                destination = token.attrGet("src")
            else:
                continue
            url = urlsplit(destination or "")
            if url.scheme or url.netloc or not url.path:
                continue
            path = unquote(url.path)
            base = root if path.startswith("/") else document.parent
            target = (base / path.lstrip("/")).resolve()
            checked += 1
            if not target.is_relative_to(root) or not target.exists():
                line = block.map[0] + 1 if block.map else 1
                errors.append(f"{name}:{line}: unresolved local target: {url.path}")
    return checked, errors


def main() -> int:
    arguments = argparse.ArgumentParser(description="Check local Markdown link and image targets. Fragments, HTML and external URLs are outside this check.")
    arguments.add_argument("--root", type=Path, required=True, help="Repository root for input paths and root-relative links")
    arguments.add_argument("documents", type=Path, nargs="+", help="Markdown files to check, relative to the root or absolute")
    options = arguments.parse_args()
    root = options.root.resolve()
    parser = MarkdownIt("commonmark").enable("table")
    checked = 0
    errors = []
    for document in options.documents:
        try:
            count, problems = check_document(root, (root / document).resolve(), parser)
        except (OSError, ValueError, RuntimeError) as error:
            errors.append(f"{document}: {error}")
            continue
        checked += count
        errors.extend(problems)
    for error in errors:
        print(error, file=sys.stderr)
    print(f"Local targets checked: {checked}. Errors: {len(errors)}.")
    return int(bool(errors))


if __name__ == "__main__":
    sys.exit(main())
