#!/usr/bin/env python3
"""
data_demo.py — 数据处理与可视化演示

这个脚本演示如何使用纯 Python（无第三方依赖）进行简单的数据处理，
并在终端中生成文本图表。适合作为教学示例代码。
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass


# ============================================================
# 数据模型
# ============================================================


@dataclass(frozen=True)
class Resource:
    """表示一个课程资源。"""

    name: str
    resource_type: str  # pdf, video, markdown, code, ppte, url
    size_mb: float


# ============================================================
# 示例数据
# ============================================================

SAMPLE_RESOURCES = [
    Resource("第一讲课件.pdf", "pdf", 2.5),
    Resource("第二讲课件.pdf", "pdf", 3.1),
    Resource("第三讲课件.pdf", "pdf", 1.8),
    Resource("课程介绍.mp4", "video", 150.0),
    Resource("实验演示.mp4", "video", 230.0),
    Resource("安装指南.md", "markdown", 0.02),
    Resource("学习笔记.md", "markdown", 0.05),
    Resource("常见问题.md", "markdown", 0.03),
    Resource("API参考.md", "markdown", 0.08),
    Resource("hello_world.py", "code", 0.01),
    Resource("data_analysis.py", "code", 0.03),
    Resource("功能概览.ppte", "ppte", 0.5),
    Resource("课程大纲.ppte", "ppte", 0.3),
    Resource("官方文档", "url", 0.0),
    Resource("参考论文", "url", 0.0),
]


# ============================================================
# 数据分析函数
# ============================================================


def count_by_type(resources: list[Resource]) -> dict[str, int]:
    """统计每种类型的资源数量。"""
    return dict(Counter(r.resource_type for r in resources))


def total_size_by_type(resources: list[Resource]) -> dict[str, float]:
    """计算每种类型的总文件大小（MB）。"""
    result: dict[str, float] = {}
    for r in resources:
        result[r.resource_type] = result.get(r.resource_type, 0.0) + r.size_mb
    return result


def top_n_largest(resources: list[Resource], n: int = 5) -> list[Resource]:
    """返回最大的 N 个资源。"""
    return sorted(resources, key=lambda r: r.size_mb, reverse=True)[:n]


# ============================================================
# 文本图表
# ============================================================

# 资源类型的中文标签
TYPE_LABELS = {
    "pdf": "PDF 文档",
    "video": "视频文件",
    "markdown": "Markdown",
    "code": "源代码  ",
    "ppte": "PPTE 幻灯片",
    "url": "外部链接",
}

# 图表使用的字符块
BAR_CHAR = "█"
BAR_HALF = "▌"


def render_bar_chart(data: dict[str, int | float], title: str, unit: str = "") -> str:
    """
    将数据渲染为文本柱状图。

    参数:
        data:  字典 {标签: 数值}
        title: 图表标题
        unit:  数值单位

    返回:
        图表的字符串表示
    """
    if not data:
        return "  (无数据)"

    max_val = max(data.values())
    max_bar_width = 30
    lines = [f"\n  {title}", "  " + "─" * 50]

    for key, val in sorted(data.items(), key=lambda x: -x[1]):
        label = TYPE_LABELS.get(key, key)
        bar_width = int((val / max_val) * max_bar_width) if max_val > 0 else 0
        bar = BAR_CHAR * bar_width

        if unit:
            val_str = f"{val:.1f} {unit}" if isinstance(val, float) else f"{val} {unit}"
        else:
            val_str = f"{val:.1f}" if isinstance(val, float) else str(val)

        lines.append(f"  {label:<12} {bar} {val_str}")

    lines.append("")
    return "\n".join(lines)


def render_table(resources: list[Resource], title: str) -> str:
    """将资源列表渲染为文本表格。"""
    lines = [
        f"\n  {title}",
        "  " + "─" * 50,
        f"  {'名称':<20} {'类型':<10} {'大小':>10}",
        "  " + "─" * 50,
    ]

    for r in resources:
        size_str = f"{r.size_mb:.1f} MB" if r.size_mb > 0 else "N/A"
        type_str = TYPE_LABELS.get(r.resource_type, r.resource_type)
        lines.append(f"  {r.name:<20} {type_str:<12} {size_str:>8}")

    lines.append("  " + "─" * 50)
    lines.append("")
    return "\n".join(lines)


# ============================================================
# 主程序
# ============================================================


def main():
    """主程序：分析示例课程资源数据并输出可视化报告。"""
    print()
    print("=" * 56)
    print("   演讲宝 — 课程资源数据分析演示")
    print("=" * 56)

    # 1. 基本统计
    total = len(SAMPLE_RESOURCES)
    total_size = sum(r.size_mb for r in SAMPLE_RESOURCES)
    print(f"\n  课程资源总数: {total} 个")
    print(f"  课程总大小:   {total_size:.1f} MB ({total_size / 1024:.2f} GB)")

    # 2. 类型分布图
    type_counts = count_by_type(SAMPLE_RESOURCES)
    print(render_bar_chart(type_counts, "资源类型分布（数量）", "个"))

    # 3. 大小分布图
    type_sizes = total_size_by_type(SAMPLE_RESOURCES)
    print(render_bar_chart(type_sizes, "资源类型分布（大小）", "MB"))

    # 4. 最大文件排名
    top5 = top_n_largest(SAMPLE_RESOURCES)
    print(render_table(top5, "最大的 5 个资源文件"))

    # 5. 格式占比
    print("  格式占比：")
    print("  " + "─" * 50)
    for rtype, count in sorted(type_counts.items(), key=lambda x: -x[1]):
        pct = (count / total) * 100
        label = TYPE_LABELS.get(rtype, rtype)
        dots = "·" * int(pct / 2)
        print(f"  {label:<12} {dots} {pct:.0f}%")
    print()

    print("=" * 56)
    print("  提示：在演讲宝中可以浏览 PDF、视频、Markdown、")
    print("  代码、PPTE 幻灯片等各种格式的课程资源。")
    print("=" * 56)
    print()


if __name__ == "__main__":
    main()
