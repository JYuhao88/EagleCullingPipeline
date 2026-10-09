"""GPU runtime probe only: no IQA model, photo reads or Eagle writes."""
import importlib.metadata
import json
import sys
import time


def main():
    try:
        import torch
        import torchvision
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA unavailable; no silent CPU fallback")
        # This constrains PyTorch's allocator, not total driver memory or other
        # processes. It does not reserve 25% of VRAM on startup.
        torch.cuda.set_per_process_memory_fraction(0.25)
        device = torch.device("cuda:0")
        with torch.inference_mode():
            left = torch.ones((1024, 1024), device=device)
            right = torch.ones_like(left)
            for _ in range(3):
                output = left @ right
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
            started = time.perf_counter()
            for _ in range(10):
                output = left @ right
            torch.cuda.synchronize()
            elapsed = (time.perf_counter() - started) * 1000
            if not torch.isfinite(output).all().item() or output[0, 0].item() != 1024:
                raise RuntimeError("GPU arithmetic validation failed")
        report = {
            "available": True, "torch": torch.__version__,
            "torchvision": torchvision.__version__, "cudaRuntime": torch.version.cuda,
            "device": torch.cuda.get_device_name(0),
            "deviceTotalMiB": round(torch.cuda.get_device_properties(0).total_memory / 1024**2),
            "threads": torch.get_num_threads(), "interopThreads": torch.get_num_interop_threads(),
            "allocatorBudgetFraction": 0.25, "matrixIterations": 10,
            "elapsedMs": round(elapsed, 2),
            "peakTorchAllocatedMiB": round(torch.cuda.max_memory_allocated() / 1024**2, 2),
            "peakTorchReservedMiB": round(torch.cuda.max_memory_reserved() / 1024**2, 2),
            "versions": {name: importlib.metadata.version(name) for name in ("torch", "torchvision", "numpy")},
            "caveats": ["This verifies CUDA arithmetic, not IQA quality, model inference or plugin integration.",
                        "Allocator counters exclude CUDA context/library allocations and other applications."]
        }
        print(json.dumps(report, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"available": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
