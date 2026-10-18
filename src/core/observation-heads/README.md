# 本地观察分类头

此目录放通过上线验收的 JSON 分类头；不提交探针或研究数据权重。当前为 `clip-face-v1.json`（在笑、嘴张开），
由 `python3 -m ml.observe.train_heads --head src/core/observation-heads/clip-face-v1.json` 生成，只用 Open Images 训练。
删除此目录下的 JSON 即关闭该功能。格式、特征预处理、校准与缓存契约见 [contracts.md](../../../docs/contracts.md) 的「本地模型观察」。
测试假头仅放在 `test/fixtures/`，不会自动加载。
