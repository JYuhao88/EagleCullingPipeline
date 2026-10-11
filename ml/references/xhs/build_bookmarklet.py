"""Builds install.html containing a draggable bookmarklet from export_note.js."""
import html
import pathlib
import urllib.parse

HERE = pathlib.Path(__file__).parent


def main():
    src = (HERE / "export_note.js").read_text(encoding="utf-8")
    body = "\n".join(line for line in src.splitlines() if not line.lstrip().startswith("//"))
    href = "javascript:" + urllib.parse.quote(body, safe="(){}[];,.=:'\"!?&|<>+-*/%^~ ")
    page = f"""<!doctype html>
<meta charset="utf-8">
<title>小红书笔记导出 书签</title>
<body style="font-family:-apple-system,sans-serif;max-width:640px;margin:48px auto;line-height:1.7">
<h2>小红书笔记导出</h2>
<p>把下面的按钮拖到 Edge 收藏夹栏（没显示收藏夹栏就按 <kbd>⇧⌘B</kbd>）：</p>
<p><a href="{html.escape(href, quote=True)}" style="display:inline-block;padding:8px 16px;background:#ff2442;color:#fff;border-radius:8px;text-decoration:none">导出小红书笔记</a></p>
<ol>
<li>正常打开一篇笔记详情。</li>
<li>在评论区往下滚，让想要的评论（和"展开回复"）加载出来。</li>
<li>点收藏夹栏里的「导出小红书笔记」，JSON 会下载到「下载」文件夹。</li>
</ol>
<p>只导出正文、标签、互动数和评论文本，不含用户名、头像、主页链接。</p>
</body>
"""
    (HERE / "install.html").write_text(page, encoding="utf-8")
    print(HERE / "install.html")


if __name__ == "__main__":
    main()
