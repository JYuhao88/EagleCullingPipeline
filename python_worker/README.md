# Optional GPU model worker

This worker is intentionally separate from the Node baseline. It accepts JSON
records on stdin and emits one JSON result per line, so the Node service can
use it without changing the Eagle plugin contract.

For the lightweight Windows ONNX/DirectML worker, create the environment with:

```powershell
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -r python_worker\requirements-onnx.txt
```

Run a smoke test:

```powershell
Get-Content input.jsonl | .venv\Scripts\python.exe python_worker\worker.py
```

The optional TorchScript worker uses a local DINOv2 checkpoint when `EAGLE_DINO_CHECKPOINT` is set;
otherwise it reports `model_unavailable` rather than downloading or sending
photos anywhere implicitly.

The heavier TorchScript path is optional; install
`python_worker/requirements-torch.txt` with the CUDA-specific PyTorch index
only when that path is needed.

Closed-eye detection uses `face_worker.py` with the downloaded MediaPipe task:

```powershell
@'{"id":"ITEM_ID","filePath":"D:/path/photo.jpg"}'@ |
  .venv\Scripts\python.exe python_worker\face_worker.py
```

For Windows GPU, install `onnxruntime-directml` (the current workstation
reported `DmlExecutionProvider`) and set
`EAGLE_DINO_ONNX=models/dinov2-small/model.onnx`, then run `onnx_worker.py`.
The worker prefers DirectML, then CUDA, then CPU, and reports the provider in
each JSON result.
