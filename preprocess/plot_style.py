"""Shared visual system for generated static figures.

The target is a cohesive visualization-work palette rather than isolated chart
defaults: white publication background, blue-gray density fields, restrained
categorical layers, and a small amber accent for emphasis.
"""

import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap


PAPER = {
    "bg": "#FFFFFF",
    "panel": "#FFFFFF",
    "panel2": "#F8FAFC",
    "ink": "#172033",
    "muted": "#667085",
    "grid": "#E3E8F0",
    "spine": "#C8D2E0",
    "blue": "#1F6F9E",
    "sky": "#55B6D9",
    "teal": "#168C8C",
    "green": "#6B9D7A",
    "orange": "#C28A2E",
    "red": "#B75A4C",
    "purple": "#7B6BA8",
    "rose": "#A86F8F",
    "slate": "#516173",
    "void": "#D9E4EE",
    "sheet": "#AFC5D6",
    "filament": "#5F9CB8",
    "node": "#C28A2E",
}

OKABE_ITO = [
    "#1F6F9E",
    "#C28A2E",
    "#168C8C",
    "#6B9D7A",
    "#55B6D9",
    "#7FA8BE",
    "#516173",
    "#172033",
]

WEB_CLASSES = {
    "void": PAPER["void"],
    "sheet": PAPER["sheet"],
    "filament": PAPER["filament"],
    "node": PAPER["node"],
}

WEB_CLASSES_MUTED = {
    "void": "#D9E4EE",
    "sheet": "#B9CBD8",
    "filament": "#78AAC0",
    "node": "#D7B66A",
}


def apply_paper_style():
    plt.rcParams.update({
        "font.family": "serif",
        "font.serif": ["Times New Roman", "DejaVu Serif"],
        "axes.unicode_minus": False,
        "figure.facecolor": PAPER["bg"],
        "axes.facecolor": PAPER["panel"],
        "savefig.facecolor": PAPER["bg"],
        "savefig.bbox": "tight",
        "savefig.pad_inches": 0.06,
        "text.color": PAPER["ink"],
        "axes.labelcolor": PAPER["ink"],
        "axes.titlecolor": PAPER["ink"],
        "axes.edgecolor": PAPER["spine"],
        "xtick.color": PAPER["muted"],
        "ytick.color": PAPER["muted"],
        "grid.color": PAPER["grid"],
        "grid.linewidth": 0.8,
        "grid.alpha": 0.65,
        "axes.grid": True,
        "axes.axisbelow": True,
        "figure.edgecolor": PAPER["bg"],
        "font.size": 10,
        "axes.titlesize": 11,
        "axes.labelsize": 10,
        "xtick.labelsize": 9,
        "ytick.labelsize": 9,
        "legend.fontsize": 8.5,
        "figure.titlesize": 13,
        "lines.linewidth": 1.9,
        "patch.linewidth": 0.7,
        "legend.facecolor": PAPER["panel2"],
        "legend.edgecolor": PAPER["grid"],
        "legend.labelcolor": PAPER["ink"],
    })


def despine(ax):
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(PAPER["spine"])
    ax.spines["bottom"].set_color(PAPER["spine"])


def style_axes(ax, grid=True):
    if grid:
        ax.grid(True, alpha=0.75)
    else:
        ax.grid(False)
    despine(ax)


def legend_clean(ax, **kwargs):
    defaults = {
        "frameon": True,
        "framealpha": 0.92,
        "facecolor": PAPER["panel2"],
        "edgecolor": PAPER["grid"],
        "labelcolor": PAPER["ink"],
    }
    defaults.update(kwargs)
    return ax.legend(**defaults)


def add_panel_label(ax, label):
    ax.text(
        0.012,
        0.988,
        label,
        transform=ax.transAxes,
        va="top",
        ha="left",
        fontsize=10,
        fontweight="bold",
        color=PAPER["ink"],
        bbox={"boxstyle": "round,pad=0.18", "facecolor": PAPER["panel2"], "edgecolor": PAPER["grid"], "alpha": 0.92},
    )


DENSITY_CMAP = LinearSegmentedColormap.from_list(
    "density_visual_system",
    ["#FFFFFF", "#E6F0F6", "#B9D4E4", "#71AAC6", "#2E739E", "#0C2E4E", "#020617"],
)

DENSITY_CMAP_STRONG = LinearSegmentedColormap.from_list(
    "density_visual_system_strong",
    ["#FFFFFF", "#DCEBF3", "#94C3D7", "#3E8CB0", "#135780", "#041A30", "#000000"],
)

HEAT_CMAP = LinearSegmentedColormap.from_list(
    "heat_visual_system",
    ["#FFFFFF", "#E7F1F7", "#BBD7E5", "#79B2C9", "#2F7FA5", "#C28A2E"],
)

DIVERGING_CMAP = LinearSegmentedColormap.from_list(
    "delta_visual_system",
    ["#2F7FA5", "#FFFFFF", "#C28A2E"],
)
