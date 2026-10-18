"""Fixed eye-band candidate for the gaze probe; not a deployed observation input."""
from pathlib import Path

from ml.observe.embed import _vips_image


EYE_RECT = (64, 112, 256, 112)
EYE_VERSION = 'face384-eye-64-112-256-112-stretch384-v1'


def eye_crop(source, destination):
    image = _vips_image(source, autorot=True)
    if image is None:
        raise RuntimeError('pyvips is required; no alternate preprocessing for this probe')
    if image.width != 384 or image.height != 384:
        raise ValueError('eye band requires the existing 384 square face view')
    left, top, width, height = EYE_RECT
    image.extract_area(left, top, width, height).resize(384 / width, vscale=384 / height,
                                                     kernel='lanczos3').pngsave(str(Path(destination)))
