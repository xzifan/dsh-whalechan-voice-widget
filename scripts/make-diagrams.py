#!/usr/bin/env python3
"""生成 README 用的说明图（纯 SVG，无外部依赖）。

用法：python3 scripts/make-diagrams.py
输出：docs/images/architecture.svg、docs/images/pipeline.svg
"""
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "images"
OUT.mkdir(parents=True, exist_ok=True)

BG = "#0b0d10"
CARD = "#141820"
CARD2 = "#101419"
LINE = "#2b313c"
TEXT = "#e6edf3"
MUTED = "#8b949e"
ACCENT = "#6aa9ff"
GREEN = "#7ee787"
AMBER = "#f0b429"
PINK = "#ff9ecb"

FONT = "'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',system-ui,sans-serif"
MONO = "ui-monospace,SFMono-Regular,Menlo,monospace"


def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def box(x, y, w, h, title, sub=None, accent=ACCENT, dash=False, fill=CARD):
    dash_attr = ' stroke-dasharray="5 4"' if dash else ""
    out = [
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" '
        f'stroke="{accent}" stroke-opacity="0.55" stroke-width="1.2"{dash_attr}/>',
        f'<text x="{x + 14}" y="{y + 24}" fill="{TEXT}" font-size="14.5" font-weight="600">{esc(title)}</text>',
    ]
    if sub:
        for i, line in enumerate(sub):
            out.append(
                f'<text x="{x + 14}" y="{y + 46 + i * 17}" fill="{MUTED}" font-size="11.8" '
                f'font-family="{MONO if line.startswith("`") else FONT}">{esc(line.strip("`"))}</text>'
            )
    return "\n".join(out)


def arrow(x1, y1, x2, y2, label=None, color=LINE, dash=False, curve=None, lx=0, ly=0):
    dash_attr = ' stroke-dasharray="4 4"' if dash else ""
    if curve:
        d = f"M {x1} {y1} C {curve[0]} {curve[1]}, {curve[2]} {curve[3]}, {x2} {y2}"
    else:
        d = f"M {x1} {y1} L {x2} {y2}"
    out = [f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.4"{dash_attr} marker-end="url(#a)"/>']
    if label:
        out.append(
            f'<text x="{(x1 + x2) / 2 + lx}" y="{(y1 + y2) / 2 + ly}" fill="{MUTED}" font-size="11" '
            f'text-anchor="middle">{esc(label)}</text>'
        )
    return "\n".join(out)


DEFS = f'''<defs>
  <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="{LINE}"/>
  </marker>
</defs>'''


def architecture():
    W, H = 1000, 560
    p = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{FONT}">',
         DEFS,
         f'<rect width="{W}" height="{H}" fill="{BG}"/>',
         f'<text x="32" y="46" fill="{TEXT}" font-size="19" font-weight="700">架构：Realtime 是大脑，TTS 是可换的声音层</text>',
         f'<text x="32" y="70" fill="{MUTED}" font-size="12.5">一条链路：麦克风 → 实时模型（理解/回复/打断/工具）→ 文字 → 声音层 → 播放</text>']

    # 主干（上行）
    p.append(box(32, 110, 150, 66, "麦克风", ["16kHz PCM"], ACCENT))
    p.append(box(222, 110, 190, 66, "浏览器前端", ["采集 / 播放 / 字幕"], ACCENT))
    p.append(box(452, 100, 190, 86, "插件后端", ["WebSocket 会话托管", "鉴权 + 限流", "工具调用转 DSH 执行"], ACCENT))
    p.append(box(682, 100, 286, 86, "Qwen-Audio-Realtime", ["理解 · 回复 · 语义打断", "smart_turn / Function Calling"], PINK))

    p.append(arrow(182, 143, 218, 143, "PCM", ly=-8))
    p.append(arrow(412, 143, 448, 143, "WS", ly=-8))
    p.append(arrow(642, 143, 678, 143, "音频", ly=-8))

    # 下行：文字 → TTS → 音频 → 播放
    p.append(box(682, 250, 286, 70, "TTS 声音层（可替换）", ["Qwen TTS · Breeze Blue · OpenAI", "或关掉自定义语音用 Realtime 原生"], GREEN))
    p.append(arrow(825, 186, 825, 246, "回复文字", ly=6, lx=44))

    p.append(box(452, 250, 190, 70, "合成音频", ["PCM 队列 / 打断即清空"], GREEN))
    p.append(arrow(682, 285, 646, 285, "音频", ly=-8))
    p.append(arrow(452, 285, 416, 285, "PCM", ly=-8))

    p.append(box(222, 250, 190, 70, "浏览器播放", ["播放状态回传，中断即停"], GREEN))

    # 支撑面
    p.append(f'<text x="32" y="380" fill="{MUTED}" font-size="12" font-weight="600">支撑面（所有链路共用）</text>')
    p.append(box(32, 396, 222, 74, "DSH 工具执行", ["tools.execute", "审批 / guard / 文件沙箱"], AMBER))
    p.append(box(272, 396, 222, 74, "审计与统计", ["JSONL · 2000 条 / 10 MiB", "转录 / 用量 / 工具记录"], AMBER))
    p.append(box(512, 396, 222, 74, "人格", ["~/.dsh/AGENTS.md", "身份 / 性格 / 禁忌 / 风格"], AMBER))
    p.append(box(752, 396, 222, 74, "凭据", ["DSH credentials 服务", "只存引用，不进提示词"], AMBER))

    p.append('</svg>')
    return "\n".join(p)


def pipeline():
    W, H = 1000, 620
    p = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{FONT}">',
         DEFS,
         f'<rect width="{W}" height="{H}" fill="{BG}"/>',
         f'<text x="32" y="46" fill="{TEXT}" font-size="19" font-weight="700">自动化：迭代循环 + 定时发布</text>',
         f'<text x="32" y="70" fill="{MUTED}" font-size="12.5">每小时推进一个改进项；工作日 16:00 发 patch，周六 16:00 发 minor</text>']

    # 三个作业
    p.append(box(32, 100, 296, 96, "J1 迭代循环", ["17 * * * *（每小时）", "[plan] 条目先派只读子代理规划", "主代理决策 → 实现 → 测试 → 提交"], ACCENT))
    p.append(box(352, 100, 296, 96, "J2 patch 发布", ["0 16,18 * * 1-5", "18:00 是补跑位", "当天已发则跳过"], GREEN))
    p.append(box(672, 100, 296, 96, "J3 minor 发布", ["0 16,18 * * 6", "全量 npm ci 回归", "额外建 GitHub Release"], GREEN))

    # 两条支线
    p.append(box(32, 232, 296, 78, "BACKLOG → 代码", ["单条 ≤200 行 · 测试不全绿则回滚", "git commit，不 bump 不部署"], ACCENT, dash=True))
    p.append(arrow(180, 196, 180, 228, "取一条", ly=-4))

    p.append(box(352, 232, 616, 78, "scripts/release.sh --deploy", ["测试门禁 → CHANGELOG → bump → pack → 安装 → 重启 → 健康校验 → commit/tag/push"], GREEN))
    p.append(arrow(500, 196, 500, 228, "发版", ly=-4))

    # 门禁与失败分支
    p.append(f'<text x="32" y="352" fill="{MUTED}" font-size="12" font-weight="600">闸门与失败处理</text>')
    p.append(box(32, 368, 296, 92, "测试红 → 不发版", ["npm test ≥279 / test:web ≥100", "退出码 2，工作区不脏"], "#ff7b72"))
    p.append(box(352, 368, 296, 92, "推送失败 → 排队", ["记 pending_push_version", "下一班次只补推，不重复 bump"], AMBER))
    p.append(box(672, 368, 296, 92, "通话中 → 推迟", ["审计 10 分钟内被写过", "或 .work.lock 存在（迭代在改）"], AMBER))

    # 状态与结果
    p.append(f'<text x="32" y="478" fill="{MUTED}" font-size="12" font-weight="600">产物与结果</text>')
    p.append(box(32, 492, 296, 92, "state / 日志", [".release-state.json", ".release-logs/<ts>-<slot>.log", ".work.lock · .release.lock"], MUTED))
    p.append(box(352, 492, 296, 92, "健康校验", ["GET /api/voice-workbench/health", "ok + version + TTS 就绪"], GREEN))
    p.append(box(672, 492, 296, 92, "报告", ["Feishu：版本 / 测试数 / 部署结果", "失败附用例名或日志尾部"], PINK))

    p.append(arrow(180, 310, 180, 364, None, dash=True))
    p.append(arrow(500, 310, 500, 364, None, dash=True))
    p.append('</svg>')
    return "\n".join(p)


(OUT / "architecture.svg").write_text(architecture(), encoding="utf-8")
(OUT / "pipeline.svg").write_text(pipeline(), encoding="utf-8")
print("wrote", OUT / "architecture.svg", (OUT / "architecture.svg").stat().st_size, "bytes")
print("wrote", OUT / "pipeline.svg", (OUT / "pipeline.svg").stat().st_size, "bytes")
