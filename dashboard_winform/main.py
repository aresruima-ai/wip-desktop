# -*- coding: utf-8 -*-
"""AI看板管理器 — 桌面控制面板(tkinter, 精致UI)。

原生桌面窗口, 通过 HTTP 调 dashboard_manager 控制面板 API(8081)。
UI: 暗色卡片式状态网格(值彩色) + 大字体 + 按钮 hover + 日志着色/过滤/源切换。

依赖: requests(tkinter 标准库)。运行: python main.py 或双击 run.bat。
"""
from __future__ import annotations

import tkinter as tk
from tkinter import messagebox
import requests

MANAGER_URL = "http://127.0.0.1:8081"

# 暗色配色
BG = "#0d1117"
CARD = "#161b22"
LOGBG = "#010409"
FG = "#c9d1d9"
GRAY = "#8b949e"
BORDER = "#30363d"
ACCENT = "#58a6ff"
WARN_C = "#f0b429"
ERR_C = "#e05260"
GREEN = "#3ecf8e"
RED = "#e05260"

# 字体(清晰大)
F_TITLE = ("Microsoft YaHei UI", 17, "bold")
F_SUB = ("Microsoft YaHei UI", 10)
F_VAL = ("Microsoft YaHei UI", 15)
F_LBL = ("Microsoft YaHei UI", 9)
F_BTN = ("Microsoft YaHei UI", 11)
F_LOG = ("Consolas", 10)
F_CTRL = ("Microsoft YaHei UI", 9)


class DashboardApp:
    """控制面板应用(tkinter, 卡片式精致UI)。"""

    def __init__(self, root):
        self.root = root
        root.title("AI看板管理器 · 控制面板")
        root.geometry("880x780")
        root.minsize(760, 660)
        root.configure(bg=BG)

        # 标题
        tk.Label(
            root, text="🛡  AI看板管理器", bg=BG, fg=FG, font=F_TITLE,
        ).pack(anchor="w", padx=24, pady=(20, 0))
        tk.Label(
            root, text="控制面板 · 实时守护状态", bg=BG, fg=GRAY, font=F_SUB,
        ).pack(anchor="w", padx=24, pady=(2, 14))

        # 状态卡片网格(5列 x 2行)
        cf = tk.Frame(root, bg=BG)
        cf.pack(fill="x", padx=24, pady=4)
        self.cards = {}
        cards = [
            ("node", "看板状态", 0, 0), ("pid", "Node PID", 0, 1), ("restart", "累计重启", 0, 2),
            ("crash", "连续崩溃", 0, 3), ("health", "探活", 0, 4),
            ("cookie", "MES Cookie", 1, 0), ("circuit", "熔断", 1, 1), ("kiosk", "投屏 PID", 1, 2),
            ("uptime", "运行时长", 1, 3), ("muted", "守护", 1, 4),
        ]
        for key, label, r, c in cards:
            self._card(cf, key, label, r, c)

        # 控制按钮
        bf = tk.Frame(root, bg=BG)
        bf.pack(fill="x", padx=24, pady=16)
        self._btn(bf, "⟳  重启看板", self.on_restart_node, danger=True)
        self._btn(bf, "⟳  重启投屏", self.on_restart_kiosk)
        self.btn_mute = self._btn(bf, "⏸  暂停守护", self.on_toggle_mute)
        self._btn(bf, "☰  刷新日志", self.on_refresh_logs)

        # 日志控制行
        lc = tk.Frame(root, bg=BG)
        lc.pack(fill="x", padx=24, pady=(0, 4))
        tk.Label(lc, text="日志", bg=BG, fg=GRAY, font=F_CTRL).pack(side="left", padx=(0, 10))
        self.log_source = "manager"
        self.btn_src_mgr = self._sbtn(lc, "manager日志", lambda: self._set_source("manager"))
        self.btn_src_node = self._sbtn(lc, "node日志", lambda: self._set_source("node"))
        tk.Label(lc, text="│", bg=BG, fg=GRAY).pack(side="left", padx=8)
        self.log_filter = "all"
        self.btn_f_all = self._sbtn(lc, "全部", lambda: self._set_filter("all"))
        self.btn_f_warn = self._sbtn(lc, "警告+", lambda: self._set_filter("warn"))
        self.btn_f_err = self._sbtn(lc, "仅错误", lambda: self._set_filter("error"))
        tk.Label(lc, text="│", bg=BG, fg=GRAY).pack(side="left", padx=8)
        self.auto_scroll = tk.BooleanVar(value=True)
        tk.Checkbutton(
            lc, text="自动滚动", variable=self.auto_scroll, bg=BG, fg=FG,
            selectcolor=CARD, activebackground=BG, activeforeground=FG, font=F_CTRL,
        ).pack(side="left")

        # 日志框(着色)
        self.txt_log = tk.Text(
            root, bg=LOGBG, fg=FG, font=F_LOG, height=16, wrap="char",
            relief="flat", bd=0, highlightbackground=BORDER, highlightthickness=1,
            padx=10, pady=8,
        )
        self.txt_log.tag_config("err", foreground=ERR_C)
        self.txt_log.tag_config("warn", foreground=WARN_C)
        self.txt_log.tag_config("info", foreground=FG)
        self.txt_log.pack(fill="both", expand=True, padx=24, pady=(0, 18))

        self._tc = 0
        self._update_ctrl_highlight()
        self.refresh_status()
        self.refresh_logs()
        self.root.after(3000, self._tick)

    # ---- 控件构造 ----
    def _card(self, parent, key, label, r, c):
        f = tk.Frame(parent, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
        f.grid(row=r, column=c, sticky="nsew", padx=5, pady=5)
        tk.Label(f, text=label, bg=CARD, fg=GRAY, font=F_LBL).pack(anchor="w", padx=14, pady=(10, 2))
        lbl = tk.Label(f, text="-", bg=CARD, fg=FG, font=F_VAL)
        lbl.pack(anchor="w", padx=14, pady=(0, 12))
        self.cards[key] = lbl
        parent.grid_columnconfigure(c, weight=1)

    def _btn(self, frame, text, cmd, danger=False):
        b = tk.Button(
            frame, text=text, bg=CARD, fg=FG, font=F_BTN, relief="flat", bd=0,
            highlightthickness=0, padx=20, pady=10, command=cmd, cursor="hand2",
        )
        if danger:
            b.bind("<Enter>", lambda e: b.config(fg=ERR_C, bg=BORDER))
            b.bind("<Leave>", lambda e: b.config(fg=FG, bg=CARD))
        else:
            b.bind("<Enter>", lambda e: b.config(fg=ACCENT, bg=BORDER))
            b.bind("<Leave>", lambda e: b.config(fg=FG, bg=CARD))
        b.pack(side="left", padx=(0, 12))
        return b

    def _sbtn(self, frame, text, cmd):
        b = tk.Button(
            frame, text=text, font=F_CTRL, relief="flat", bd=0, highlightthickness=0,
            padx=10, pady=5, command=cmd, cursor="hand2", bg=CARD, fg=FG,
        )
        b.bind("<Enter>", lambda e: b.config(bg=BORDER))
        b.bind("<Leave>", lambda e: self._update_ctrl_highlight())
        b.pack(side="left", padx=(0, 4))
        return b

    def _update_ctrl_highlight(self):
        """高亮当前选中的源/过滤按钮。"""
        for btn, active in [
            (self.btn_src_mgr, self.log_source == "manager"),
            (self.btn_src_node, self.log_source == "node"),
            (self.btn_f_all, self.log_filter == "all"),
            (self.btn_f_warn, self.log_filter == "warn"),
            (self.btn_f_err, self.log_filter == "error"),
        ]:
            btn.config(
                bg=ACCENT if active else CARD,
                fg=BG if active else FG,
            )

    def _set_source(self, src):
        self.log_source = src
        self._update_ctrl_highlight()
        self.refresh_logs()

    def _set_filter(self, f):
        self.log_filter = f
        self._update_ctrl_highlight()
        self.refresh_logs()

    # ---- 轮询 ----
    def _tick(self):
        self.refresh_status()
        self._tc += 1
        if self._tc % 2 == 0:
            self.refresh_logs()
        self.root.after(3000, self._tick)

    def refresh_status(self):
        try:
            s = requests.get(MANAGER_URL + "/api/status", timeout=2).json()
            node = s["node_status"]
            self.cards["node"].config(
                text=node, fg=GREEN if node == "运行中" else (RED if node == "熔断" else GRAY))
            self.cards["pid"].config(text=str(s["node_pid"]))
            self.cards["restart"].config(text=str(s["restart_count"]))
            self.cards["crash"].config(text=str(s["consecutive_crashes"]))
            h = s["last_health_ok"]
            self.cards["health"].config(
                text="✓ 正常" if h is True else ("✗ 失败" if h is False else "—"),
                fg=GREEN if h is True else (RED if h is False else GRAY))
            ck = s["last_has_cookie"]
            self.cards["cookie"].config(
                text="有" if ck is True else ("丢失" if ck is False else "—"),
                fg=GREEN if ck is True else (RED if ck is False else GRAY))
            self.cards["circuit"].config(
                text="熔断中" if s["circuit_open"] else "正常",
                fg=RED if s["circuit_open"] else FG)
            self.cards["kiosk"].config(text=str(s["kiosk_pid"]))
            self.cards["uptime"].config(text=str(s["uptime"]) + "s")
            self.cards["muted"].config(
                text="已暂停" if s["muted"] else "运行中",
                fg=WARN_C if s["muted"] else GREEN)
            self.btn_mute.config(text="▶  恢复守护" if s["muted"] else "⏸  暂停守护")
        except Exception as e:
            for k in self.cards:
                self.cards[k].config(text="—", fg=GRAY)
            self.cards["node"].config(text="连接失败", fg=RED)

    def refresh_logs(self):
        try:
            url = MANAGER_URL + "/api/logs?source=" + self.log_source + "&lines=500"
            t = requests.get(url, timeout=3).text
            lines = t.split("\n")
            self.txt_log.config(state="normal")
            self.txt_log.delete("1.0", "end")
            for line in lines:
                if not line.strip():
                    continue
                if self.log_filter == "warn" and "[WARNING]" not in line and "[ERROR]" not in line:
                    continue
                if self.log_filter == "error" and "[ERROR]" not in line:
                    continue
                if "[ERROR]" in line:
                    tag = "err"
                elif "[WARNING]" in line:
                    tag = "warn"
                else:
                    tag = "info"
                self.txt_log.insert("end", line + "\n", tag)
            if self.auto_scroll.get():
                self.txt_log.see("end")
            self.txt_log.config(state="disabled")
        except Exception as e:
            self.txt_log.config(state="normal")
            self.txt_log.delete("1.0", "end")
            self.txt_log.insert("end", "日志获取失败: " + str(e), "err")
            self.txt_log.config(state="disabled")

    # ---- 控制 ----
    def _confirm_post(self, action, label):
        if not messagebox.askyesno("确认", "确认" + label + "?"):
            return
        try:
            r = requests.post(MANAGER_URL + "/api/" + action, timeout=8)
            messagebox.showinfo("结果", r.text)
            self.refresh_status()
            self.refresh_logs()
        except Exception as e:
            messagebox.showerror("错误", "失败: " + str(e))

    def on_restart_node(self):
        self._confirm_post("restart-node", "重启看板")

    def on_restart_kiosk(self):
        self._confirm_post("restart-kiosk", "重启投屏")

    def on_toggle_mute(self):
        self._confirm_post("toggle-mute", "切换守护")

    def on_refresh_logs(self):
        self.refresh_logs()


def main():
    root = tk.Tk()
    DashboardApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
