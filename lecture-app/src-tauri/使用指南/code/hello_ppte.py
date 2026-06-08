#!/usr/bin/env python3
"""
hello_ppte.py — 演讲宝 PPTE 格式欢迎演示

这个脚本展示了如何使用 Python 生成一个简单的 PPTE 幻灯片目录。
运行它可以快速了解 PPTE 格式的基本结构。
"""

import json
import os

# ============================================================
# ASCII Art 欢迎横幅
# ============================================================

BANNER = r"""
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║     _                _                                       ║
║    | |    ___  ___  | |_  _   _  _ __  ___                   ║
║    | |   / _ \/ __| | __|| | | || '__|/ _ \                  ║
║    | |__|  __/ (__  | |_ | |_| || |  |  __/                  ║
║    |_____|\___|\___| \__| \__,_||_|   \___|                  ║
║                                                              ║
║     ____                                _                    ║
║    |  _ \  _ __  ___  ___   ___  _ __  | |_  ___  _ __       ║
║    | |_) || '__|/ _ \/ __| / _ \| '_ \ | __|/ _ \| '__|     ║
║    |  __/ | |  |  __/\__ \|  __/| | | || |_|  __/| |        ║
║    |_|    |_|   \___||___/ \___||_| |_| \__|\___||_|        ║
║                                                              ║
║              演 讲 宝  —  你的智能演示助手                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
"""


def create_sample_manifest(output_dir: str = "sample_ppte") -> dict:
    """
    生成一个示例 PPTE 幻灯片的 manifest.json 结构。

    参数:
        output_dir: 输出目录名称

    返回:
        manifest 字典
    """
    manifest = {
        "title": "我的第一个 PPTE 演示",
        "slides": [
            {"file": "slide01.html", "title": "封面"},
            {"file": "slide02.html", "title": "目录"},
            {"file": "slide03.html", "title": "第一章：简介"},
            {"file": "slide04.html", "title": "第二章：内容"},
            {"file": "slide05.html", "title": "结尾"},
        ],
    }
    return manifest


def create_sample_slide(title: str, content: str, bg_color: str = "#1a1a2e") -> str:
    """
    生成一个简单的 PPTE 幻灯片 HTML 内容。

    参数:
        title:    幻灯片标题
        content:  幻灯片内容 (HTML)
        bg_color: 背景颜色

    返回:
        完整的 HTML 字符串
    """
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{title}</title>
    <style>
        html, body {{
            margin: 0; padding: 0;
            width: 100vw; height: 100vh;
            overflow: hidden;
            display: flex; align-items: center; justify-content: center;
            background: {bg_color};
            font-family: -apple-system, 'PingFang SC', sans-serif;
            color: #ffffff;
        }}
        .slide {{
            width: min(100vw, 177.78vh);
            height: min(100vh, 56.25vw);
            max-width: 100vw; max-height: 100vh;
            padding: 60px; box-sizing: border-box;
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
        }}
        h1 {{ font-size: 3em; margin-bottom: 0.5em; }}
        p  {{ font-size: 1.4em; opacity: 0.8; }}
    </style>
</head>
<body>
    <div class="slide">
        <h1>{title}</h1>
        {content}
    </div>
</body>
</html>"""


def display_ppte_structure():
    """显示 PPTE 目录结构说明。"""
    structure = """
    PPTE 目录结构：
    ┌─────────────────────────────┐
    │  my-slides/                 │
    │  ├── manifest.json          │  ← 幻灯片清单（必须）
    │  ├── slide01.html           │  ← 第一页
    │  ├── slide02.html           │  ← 第二页
    │  ├── slide03.html           │  ← 第三页
    │  └── assets/                │  ← 图片等资源（可选）
    │      └── logo.png           │
    └─────────────────────────────┘
    """
    print(structure)


def main():
    """主程序入口。"""
    print(BANNER)

    # 展示 PPTE 结构
    print("=" * 60)
    print("  PPTE (PPT-EXTRA) 格式入门")
    print("=" * 60)

    display_ppte_structure()

    # 生成示例 manifest
    manifest = create_sample_manifest()
    print("\n  示例 manifest.json：")
    print("  " + "-" * 40)
    print(json.dumps(manifest, ensure_ascii=False, indent=4))

    # 展示幻灯片页面信息
    print("\n  幻灯片列表：")
    print("  " + "-" * 40)
    for i, slide in enumerate(manifest["slides"], 1):
        print(f"  📄 第 {i} 页: {slide['title']} ({slide['file']})")

    print("\n" + "=" * 60)
    print("  提示：在演讲宝中，你可以使用课程创建器")
    print("  一键生成带模板的 PPTE 幻灯片！")
    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
