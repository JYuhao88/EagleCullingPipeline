# CLIP 文本向量复现与保守阈值检查

模型为 OpenAI CLIP ViT-B/32，使用 Xenova 的 ONNX 转换，MIT 许可证见 [clip-license.txt](clip-license.txt)。
来源：<https://huggingface.co/Xenova/clip-vit-base-patch32>；
固定版本 `d15189d7028b43f1d3e65039190477f6af591c2a`，不使用可变的 main 权重。
视觉模型为 int8 量化 ONNX，89,117,001 字节；图像和文本投影维度均为 512。
仅下载公共模型和检查样例；本机照片、预览、嵌入均不上传。

正常使用只需执行 `node scripts/download-clip.mjs`，下载至 `models/clip/` 并检查 SHA-256。
脚本内固定视觉模型、文本模型和 tokenizer 的 SHA-256；`scene-tags.json` 也记录视觉及文本权重摘要。
运行时不下载模型，也不需要 Python、文本 ONNX 或 tokenizer。

文本向量的完整复现流程（需联网下载公共模型和 Python 依赖）：

```sh
clip_work=$(mktemp -d)
python3 -m venv "$clip_work/venv"
PIP_CONFIG_FILE=/dev/null "$clip_work/venv/bin/pip" install --no-cache-dir \
  'numpy==2.2.6' 'onnxruntime==1.23.2' 'tokenizers==0.22.2'
node scripts/download-clip.mjs --text-assets "$clip_work/assets"
"$clip_work/venv/bin/python" scripts/prepare-scene-tags.py "$clip_work/assets"
rm -rf "$clip_work"
```

每个标签对应两条英文 prompt。先逐条计算 fp32 文本模型输出并归一化，再对同一标签的两条向量取均值并再次归一化。
生成的 JSON 保存 32 个中文标签及各自的 prompt、512 维向量和余弦阈值；不包含私人照片信息。
跨平台浮点结果可能有微小差异，因此文本向量保留 8 位小数，权重下载以原始文件 SHA-256 校验。

可运行 `node scripts/check-scene-tags.mjs` 重做下面检查；脚本将公开图片下载到临时目录，完成即删除。
猫、咖啡、宇航员、火箭来自 scikit-image v0.19.3 的公开样例；狗来自 pytorch/hub 公开示例。
纯白、纯黑、纯灰由本机生成。检查使用实际运行时的 sharp 预处理和量化视觉模型。

| 样例 | 语义预期 | 最相似标签（余弦） | 最终标签 |
| --- | --- | --- | --- |
| cat.png | 猫 | 猫 0.2732 | AI·猫 |
| dog.jpg | 狗 | 狗 0.2829 | AI·狗 |
| coffee.png | 美食 | 美食 0.2457 | 空 |
| astronaut.png | 人像 | 人像 0.2317 | 空 |
| rocket.jpg | 词表外 | 室内 0.2249 | 空 |
| white.png | 空 | 人群 0.2508 | 空 |
| black.png | 空 | 人群 0.2251 | 空 |
| gray.png | 空 | 人群 0.2383 | 空 |

统一阈值 0.24 会让纯白错误命中“人群”。最终统一阈值选择 0.28，仅猫依据正样例改为 0.27，每张最多 3 个标签。
这组检查优先减少误报，接受咖啡和宇航员等正样例漏标。8 张样例不足以估计通用准确率，
不同场景、裁切及相似标签仍会产生误差；余弦分数并非概率，不将低分强制补足成 1 个标签。
